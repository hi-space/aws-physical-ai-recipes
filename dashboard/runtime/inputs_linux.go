package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const receiptName = ".pai-input-receipt.json"
const inputLockName = ".pai-input-lock"

type inputPlan struct {
	Inputs []input `json:"inputs"`
}
type input struct {
	Destination  string      `json:"destination,omitempty"`
	FSXPath      string      `json:"fsxPath,omitempty"`
	Index        *int        `json:"index,omitempty"`
	ManifestHash string      `json:"manifestHash"`
	Files        []inputFile `json:"files"`
}
type inputFile struct {
	Path           string `json:"path"`
	URL            string `json:"url"`
	Size           int64  `json:"size"`
	ChecksumSHA256 string `json:"checksumSHA256,omitempty"`
	ChecksumType   string `json:"checksumType,omitempty"`
	VersionID      string `json:"versionId,omitempty"`
}
type inputReceipt struct {
	Version      int    `json:"version"`
	ManifestHash string `json:"manifestHash"`
}

func validDigest(s string) bool {
	data, err := base64.StdEncoding.DecodeString(s)
	return err == nil && len(data) == sha256.Size && base64.StdEncoding.EncodeToString(data) == s
}

func validManifestHash(s string) bool {
	data, err := hex.DecodeString(s)
	return (err == nil && len(data) == sha256.Size) || validDigest(s)
}

func validateInputs(plan *inputPlan, projectID, root, token string) error {
	if plan.Inputs == nil || len(plan.Inputs) > 64 {
		return errors.New("invalid input list")
	}
	scope := filepath.Clean(root)
	if projectID != "" {
		scope = filepath.Join(scope, "projects", projectID)
	}
	destinations := map[string]bool{}
	for i := range plan.Inputs {
		in := &plan.Inputs[i]
		if in.Destination == "" {
			in.Destination = in.FSXPath
		}
		if in.FSXPath != "" && in.FSXPath != in.Destination {
			return errors.New("conflicting input destinations")
		}
		if !safeAbsolutePath(in.Destination) || !strings.HasPrefix(in.Destination, scope+"/") ||
			!validManifestHash(in.ManifestHash) || in.Files == nil || len(in.Files) > maxCheckpointFiles ||
			(in.Index != nil && *in.Index < 0) {
			return errors.New("invalid or unscoped input manifest")
		}
		for other := range destinations {
			if other == in.Destination || strings.HasPrefix(other, in.Destination+"/") || strings.HasPrefix(in.Destination, other+"/") {
				return errors.New("overlapping input destinations")
			}
		}
		destinations[in.Destination] = true
		paths := map[string]bool{}
		for _, f := range in.Files {
			if !safeRelativePath(f.Path) || paths[f.Path] || f.Size < 0 || f.Size == 1<<63-1 {
				return errors.New("invalid input file path or size")
			}
			for _, part := range strings.Split(f.Path, "/") {
				if strings.HasPrefix(part, ".pai-input-") {
					return errors.New("input path uses a reserved runtime name")
				}
			}
			if _, err := validHTTPURL(f.URL, false); err != nil || strings.Contains(f.URL, token) {
				return errors.New("unsafe input download URL")
			}
			switch f.ChecksumType {
			case "", "FULL_OBJECT":
				if f.ChecksumSHA256 != "" && !validDigest(f.ChecksumSHA256) {
					return errors.New("invalid input SHA256 digest")
				}
			case "COMPOSITE":
				if f.ChecksumSHA256 != "" {
					digest, parts, hasParts := strings.Cut(f.ChecksumSHA256, "-")
					count, err := strconv.Atoi(parts)
					if !validDigest(digest) || (hasParts && (err != nil || count <= 0)) {
						return errors.New("invalid composite input checksum")
					}
				}
			default:
				return errors.New("unknown input checksum type")
			}
			paths[f.Path] = true
		}
		for path := range paths {
			for parent := filepath.Dir(path); parent != "."; parent = filepath.Dir(parent) {
				if paths[parent] {
					return errors.New("input manifest has file/directory conflicts")
				}
			}
		}
	}
	return nil
}

func (r *runner) prepareInputs(parent context.Context) int {
	r.stderr = &lockedWriter{writer: r.stderr}
	defer r.broker.http.CloseIdleConnections()
	bounded, finish := context.WithTimeout(parent, r.opts.publicationTimeout)
	defer finish()
	ctx, cancel := context.WithCancelCause(bounded)
	defer cancel(context.Canceled)
	if err := r.broker.heartbeat(ctx); err != nil {
		r.log(failure("input preparation failed", err))
		return 125
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for waitContext(ctx, r.opts.heartbeatInterval) == nil {
			if err := r.broker.heartbeat(ctx); err != nil {
				cancel(err)
				return
			}
		}
	}()
	defer func() { cancel(context.Canceled); <-done }()
	var plan inputPlan
	err := r.broker.request(ctx, http.MethodGet, "/runtime/inputs", nil, &plan, 200)
	if err == nil {
		err = validateInputs(&plan, r.contract.ProjectID, r.opts.inputRoot, r.broker.token)
	}
	if err == nil {
		for _, in := range plan.Inputs {
			if err = r.hydrateInput(ctx, in); err != nil {
				break
			}
		}
	}
	if err == nil {
		err = r.broker.heartbeat(ctx)
	}
	if err != nil {
		r.log(failure("input preparation failed", err))
		return 125
	}
	return 0
}

func openDirectoryAt(parent int, name string, create bool) (*os.File, error) {
	flags := syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
	fd, err := syscall.Openat(parent, name, flags, 0)
	if err == syscall.ENOENT && create {
		if err = syscall.Mkdirat(parent, name, 0755); err != nil && err != syscall.EEXIST {
			return nil, errors.New("cannot create input cache directory")
		}
		fd, err = syscall.Openat(parent, name, flags, 0)
	}
	if err != nil {
		return nil, errors.New("input cache directory missing, unreadable, or contains a symlink")
	}
	return os.NewFile(uintptr(fd), "input-cache-directory"), nil
}

func openInputDestination(path string) (*os.File, error) {
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("cannot open input filesystem root")
	}
	dir := os.NewFile(uintptr(fd), "input-root")
	for _, part := range strings.Split(strings.Trim(path, "/"), "/") {
		next, err := openDirectoryAt(int(dir.Fd()), part, true)
		dir.Close()
		if err != nil {
			return nil, err
		}
		dir = next
	}
	return dir, nil
}

func inputParent(root *os.File, path string, create bool) (*os.File, string, error) {
	parts := strings.Split(path, "/")
	fd, err := syscall.Openat(int(root.Fd()), ".", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, "", errors.New("cannot open input cache root")
	}
	dir := os.NewFile(uintptr(fd), "input-parent")
	for _, part := range parts[:len(parts)-1] {
		next, err := openDirectoryAt(int(dir.Fd()), part, create)
		dir.Close()
		if err != nil {
			return nil, "", err
		}
		dir = next
	}
	return dir, parts[len(parts)-1], nil
}

func regularFileAt(dir *os.File, name string, flags int) (*os.File, error) {
	fd, err := syscall.Openat(int(dir.Fd()), name, flags|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0644)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), "input-file")
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, errors.New("input cache entry is not a regular file")
	}
	return file, nil
}

func lockInput(ctx context.Context, dir *os.File) (*os.File, error) {
	file, err := regularFileAt(dir, inputLockName, syscall.O_RDWR|syscall.O_CREAT)
	if err != nil {
		return nil, errors.New("cannot open regular input cache lock")
	}
	for {
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return file, nil
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN {
			file.Close()
			return nil, errors.New("cannot lock input cache")
		}
		if err = waitContext(ctx, 100*time.Millisecond); err != nil {
			file.Close()
			return nil, err
		}
	}
}

func cacheMatches(ctx context.Context, dir *os.File, in input) (bool, error) {
	receipt, err := regularFileAt(dir, receiptName, syscall.O_RDONLY)
	if err != nil {
		return false, nil
	}
	raw, err := io.ReadAll(io.LimitReader(receipt, 8193))
	receipt.Close()
	var marker inputReceipt
	if err != nil || len(raw) > 8192 || strictJSON(raw, &marker) != nil || marker.Version != 1 || marker.ManifestHash != in.ManifestHash {
		return false, nil
	}
	for _, f := range in.Files {
		if ctx.Err() != nil {
			return false, context.Cause(ctx)
		}
		parent, name, err := inputParent(dir, f.Path, false)
		if err != nil {
			return false, nil
		}
		file, err := regularFileAt(parent, name, syscall.O_RDONLY)
		parent.Close()
		if err != nil {
			return false, nil
		}
		info, err := file.Stat()
		if err != nil || info.Size() != f.Size {
			file.Close()
			return false, nil
		}
		if f.ChecksumSHA256 != "" && f.ChecksumType != "COMPOSITE" {
			hash := sha256.New()
			n, err := io.Copy(hash, io.LimitReader(contextReader{ctx: ctx, reader: file}, f.Size+1))
			file.Close()
			if ctx.Err() != nil {
				return false, context.Cause(ctx)
			}
			if err != nil || n != f.Size || base64.StdEncoding.EncodeToString(hash.Sum(nil)) != f.ChecksumSHA256 {
				return false, nil
			}
		} else {
			file.Close()
		}
	}
	return true, nil
}

func temporaryInputFile(dir *os.File) (*os.File, string, error) {
	return temporaryFileAt(dir, ".pai-input-tmp-")
}

func temporaryFileAt(dir *os.File, prefix string) (*os.File, string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, "", errors.New("cannot generate temporary input filename")
	}
	name := prefix + hex.EncodeToString(random[:])
	file, err := regularFileAt(dir, name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL)
	if err != nil {
		return nil, "", errors.New("cannot create input temporary file")
	}
	return file, name, nil
}

func (r *runner) hydrateInput(ctx context.Context, in input) error {
	return r.hydrateWithURLs(ctx, in, newInputURLs(r, in))
}

func (r *runner) hydrateWithURLs(ctx context.Context, in input, urls *inputURLs) error {
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	dir, err := openInputDestination(in.Destination)
	if err != nil {
		return err
	}
	defer dir.Close()
	lock, err := lockInput(ctx, dir)
	if err != nil {
		return err
	}
	defer lock.Close() // closing releases flock
	matches, err := cacheMatches(ctx, dir, in)
	if err != nil {
		return err
	}
	if matches {
		return r.broker.heartbeat(ctx)
	}
	// An old receipt must not certify files being replaced by a new manifest.
	if err := syscall.Unlinkat(int(dir.Fd()), receiptName); err != nil && err != syscall.ENOENT {
		return errors.New("cannot invalidate input cache receipt")
	}
	if err := dir.Sync(); err != nil {
		return errors.New("cannot sync input receipt invalidation")
	}
	downloads, cancel := context.WithCancelCause(ctx)
	defer cancel(context.Canceled)
	jobs := make(chan inputFile)
	var workers sync.WaitGroup
	for i := 0; i < 4; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for f := range jobs {
				if downloads.Err() != nil {
					return
				}
				if err := r.downloadInput(downloads, dir, f, urls); err != nil {
					cancel(err)
					return
				}
			}
		}()
	}
send:
	for _, f := range in.Files {
		select {
		case jobs <- f:
		case <-downloads.Done():
			break send
		}
	}
	close(jobs)
	workers.Wait()
	if downloads.Err() != nil {
		return context.Cause(downloads)
	}
	if err := r.broker.heartbeat(ctx); err != nil {
		return err
	}
	// Write the receipt after all data renames and the final lease check.
	file, name, err := temporaryInputFile(dir)
	if err != nil {
		return err
	}
	defer syscall.Unlinkat(int(dir.Fd()), name)
	_, writeErr := fmt.Fprintf(file, `{"version":1,"manifestHash":%q}`+"\n", in.ManifestHash)
	syncErr := file.Sync()
	file.Close()
	if writeErr != nil || syncErr != nil {
		return errors.New("cannot persist input receipt")
	}
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	if err := syscall.Renameat(int(dir.Fd()), name, int(dir.Fd()), receiptName); err != nil {
		return errors.New("cannot publish input receipt")
	}
	if err := dir.Sync(); err != nil {
		syscall.Unlinkat(int(dir.Fd()), receiptName)
		return errors.New("cannot sync input receipt")
	}
	return nil
}

func (r *runner) downloadInput(ctx context.Context, root *os.File, f inputFile, urls *inputURLs) error {
	parent, name, err := inputParent(root, f.Path, true)
	if err != nil {
		return err
	}
	defer parent.Close()
	existing, err := regularFileAt(parent, name, syscall.O_RDONLY)
	if err != nil && err != syscall.ENOENT {
		return errors.New("input target is not a writable regular-file location")
	}
	if existing != nil {
		existing.Close()
	}
	temp, tempName, err := temporaryInputFile(parent)
	if err != nil {
		return err
	}
	defer temp.Close()
	defer syscall.Unlinkat(int(parent.Fd()), tempName)
	if err := r.broker.download(ctx, urls.current(f), temp, urls.refresh); err != nil {
		return err
	}
	if err := temp.Sync(); err != nil {
		return errors.New("cannot sync input file")
	}
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	if err := syscall.Renameat(int(parent.Fd()), tempName, int(parent.Fd()), name); err != nil {
		return errors.New("cannot atomically replace input file")
	}
	if err := parent.Sync(); err != nil {
		return errors.New("cannot sync input directory")
	}
	return nil
}

func (b *broker) download(ctx context.Context, f inputFile, file *os.File, refresh func(context.Context, inputFile) (string, error)) error {
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		if ctx.Err() != nil {
			return context.Cause(ctx)
		}
		if attempt > 0 {
			if err := waitContext(ctx, b.opts.retryDelay*time.Duration(1<<(attempt-1))); err != nil {
				return err
			}
		}
		if err := file.Truncate(0); err != nil {
			return errors.New("cannot reset input temporary file")
		}
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return errors.New("cannot seek input temporary file")
		}
		callCtx, cancel := context.WithTimeout(ctx, b.opts.putTimeout)
		req, err := http.NewRequestWithContext(callCtx, http.MethodGet, f.URL, nil)
		if err != nil {
			cancel()
			return errors.New("cannot create input download request")
		}
		req.Header.Set("Accept-Encoding", "identity")
		res, err := b.http.Do(req)
		if err != nil {
			cancel()
			last = errors.New("input download transport or timeout failure")
			continue
		}
		if res.StatusCode != 200 {
			res.Body.Close()
			cancel()
			last = fmt.Errorf("input download returned HTTP %d", res.StatusCode)
			if res.StatusCode == http.StatusForbidden && attempt < 2 {
				url, err := refresh(ctx, f)
				if err != nil {
					return err
				}
				f.URL = url
				continue
			}
			if res.StatusCode == 429 || res.StatusCode >= 500 {
				continue
			}
			return last
		}
		if res.ContentLength >= 0 && res.ContentLength != f.Size {
			res.Body.Close()
			cancel()
			return errors.New("input download size differs from manifest")
		}
		hash := sha256.New()
		n, copyErr := io.CopyBuffer(io.MultiWriter(file, hash), io.LimitReader(res.Body, f.Size+1), make([]byte, 128*1024))
		res.Body.Close()
		cancel()
		if copyErr != nil {
			last = errors.New("input download read/write failure")
			continue
		}
		if n != f.Size {
			return errors.New("input downloaded bytes differ from manifest size")
		}
		if f.ChecksumSHA256 != "" && f.ChecksumType != "COMPOSITE" && base64.StdEncoding.EncodeToString(hash.Sum(nil)) != f.ChecksumSHA256 {
			return errors.New("input FULL_OBJECT SHA256 mismatch")
		}
		return nil
	}
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	return last
}
