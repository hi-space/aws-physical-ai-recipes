package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	maxFileBytes       int64 = 5 * 1024 * 1024 * 1024
	maxCheckpointFiles       = 1024
)

type fileManifest struct {
	Path           string `json:"path"`
	Size           int64  `json:"size"`
	ChecksumSHA256 string `json:"checksumSHA256"`
}

type publication struct {
	Files       []fileManifest `json:"files"`
	Purpose     string         `json:"purpose"`
	Destination string         `json:"destination"`
}

type uploadPlan struct {
	Uploads []upload `json:"uploads"`
}
type upload struct {
	Path    string            `json:"path"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
}

type snapshot struct {
	directory string
	files     []fileManifest
	staged    map[string]string
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if r.ctx.Err() != nil {
		return 0, context.Cause(r.ctx)
	}
	return r.reader.Read(p)
}

// Never resolve an absolute checkpoint path through an unchecked symlink,
// including symlinks in ancestor directories. All subsequent traversal is
// relative to already-open directory descriptors.
func openCheckpointRoot(path string) (*os.File, error) {
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("cannot open filesystem root")
	}
	parts := strings.Split(strings.Trim(filepath.Clean(path), "/"), "/")
	for i, part := range parts {
		flags := syscall.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC | syscall.O_NONBLOCK
		if i < len(parts)-1 {
			flags |= syscall.O_DIRECTORY
		}
		next, openErr := syscall.Openat(fd, part, flags, 0)
		syscall.Close(fd)
		if openErr != nil {
			return nil, errors.New("checkpoint path missing, unreadable, or contains a symlink")
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), "checkpoint-root"), nil
}

func checkpointScratch(outputRoot string) (string, error) {
	protected := ""
	if outputRoot != "" {
		var err error
		protected, err = filepath.EvalSymlinks(outputRoot)
		if err != nil {
			return "", errors.New("cannot resolve output root for checkpoint scratch")
		}
		protected, err = filepath.Abs(protected)
		if err != nil {
			return "", errors.New("cannot resolve output root for checkpoint scratch")
		}
	}
	inside := func(path string) bool {
		return protected != "" && (path == protected || strings.HasPrefix(path, protected+string(filepath.Separator)))
	}
	for _, candidate := range []string{os.TempDir(), "/tmp", "/var/tmp"} {
		parent, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		parent, err = filepath.EvalSymlinks(parent)
		if err != nil || inside(parent) {
			continue
		}
		dir, err := os.MkdirTemp(parent, "pai-checkpoint-")
		if err != nil {
			continue
		}
		actual, err := filepath.EvalSymlinks(dir)
		if err != nil || inside(actual) {
			os.RemoveAll(dir)
			continue
		}
		return dir, nil
	}
	return "", errors.New("cannot allocate checkpoint scratch outside output root")
}

func takeSnapshot(ctx context.Context, cp checkpoint, outputRoot string) (*snapshot, error) {
	if ctx.Err() != nil {
		return nil, context.Cause(ctx)
	}
	root, err := openCheckpointRoot(cp.Path)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	info, err := root.Stat()
	if err != nil {
		return nil, errors.New("cannot inspect checkpoint root")
	}
	if !info.IsDir() && !info.Mode().IsRegular() {
		return nil, errors.New("checkpoint root must be a regular file or directory")
	}
	dir, err := checkpointScratch(outputRoot)
	if err != nil {
		return nil, err
	}
	s := &snapshot{directory: dir, staged: map[string]string{}}
	ok := false
	defer func() {
		if !ok {
			os.RemoveAll(dir)
		}
	}()
	add := func(f *os.File, relative string) error {
		if cp.pattern != nil && !cp.pattern.MatchString(relative) {
			return nil
		}
		if len(s.files) >= maxCheckpointFiles {
			return errors.New("checkpoint file count exceeds limit")
		}
		if !safeRelativePath(relative) {
			return errors.New("unsafe checkpoint relative path")
		}
		before, err := f.Stat()
		if err != nil || !before.Mode().IsRegular() {
			return errors.New("checkpoint file is no longer regular")
		}
		if before.Size() > maxFileBytes {
			return errors.New("checkpoint file exceeds 5 GiB; multipart upload is unsupported")
		}
		stage := filepath.Join(dir, strconv.Itoa(len(s.files)))
		out, err := os.OpenFile(stage, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return errors.New("cannot create checkpoint snapshot")
		}
		hash := sha256.New()
		n, copyErr := io.CopyBuffer(io.MultiWriter(out, hash),
			io.LimitReader(contextReader{ctx: ctx, reader: f}, maxFileBytes+1), make([]byte, 128*1024))
		closeErr := out.Close()
		if ctx.Err() != nil {
			return context.Cause(ctx)
		}
		if n > maxFileBytes {
			return errors.New("checkpoint file exceeds 5 GiB; multipart upload is unsupported")
		}
		if copyErr != nil || closeErr != nil {
			return errors.New("checkpoint snapshot read/write failed")
		}
		after, err := f.Stat()
		if err != nil || n != before.Size() || after.Size() != before.Size() || !before.ModTime().Equal(after.ModTime()) {
			return errors.New("checkpoint file changed during snapshot")
		}
		s.files = append(s.files, fileManifest{Path: relative, Size: n, ChecksumSHA256: base64.StdEncoding.EncodeToString(hash.Sum(nil))})
		s.staged[relative] = stage
		return nil
	}
	visited := 0
	var walk func(*os.File, string, int) error
	walk = func(dir *os.File, prefix string, depth int) error {
		if depth > 64 {
			return errors.New("checkpoint directory nesting exceeds limit")
		}
		for {
			if ctx.Err() != nil {
				return context.Cause(ctx)
			}
			entries, readErr := dir.ReadDir(128)
			if readErr != nil && readErr != io.EOF {
				return errors.New("cannot enumerate checkpoint directory")
			}
			for _, entry := range entries {
				visited++
				if visited > 100000 {
					return errors.New("checkpoint traversal exceeds entry limit")
				}
				if reservedRuntimeName(entry.Name()) || entry.Type()&os.ModeSymlink != 0 {
					continue
				}
				relative := entry.Name()
				if prefix != "" {
					relative = prefix + "/" + relative
				}
				if !safeRelativePath(relative) {
					return errors.New("unsafe checkpoint relative path")
				}
				flags := syscall.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC | syscall.O_NONBLOCK
				// Avoid even opening known sockets/devices/pipes. DT_UNKNOWN
				// and ordinary files are inspected again after O_NOFOLLOW open.
				if entry.Type() != 0 && !entry.IsDir() {
					continue
				}
				fd, err := syscall.Openat(int(dir.Fd()), entry.Name(), flags, 0)
				if err != nil {
					return errors.New("checkpoint entry changed, is unreadable, or is a symlink")
				}
				child := os.NewFile(uintptr(fd), "checkpoint-entry")
				stat, err := child.Stat()
				if err != nil {
					child.Close()
					return errors.New("cannot inspect checkpoint entry")
				}
				if stat.IsDir() {
					err = walk(child, relative, depth+1)
				} else if stat.Mode().IsRegular() {
					err = add(child, relative)
				}
				child.Close()
				if err != nil {
					return err
				}
			}
			if readErr == io.EOF {
				break
			}
		}
		return nil
	}
	if info.IsDir() {
		err = walk(root, "", 0)
	} else {
		err = add(root, filepath.Base(filepath.Clean(cp.Path)))
	}
	if err != nil {
		return nil, err
	}
	if len(s.files) == 0 {
		return nil, errors.New("checkpoint selection contains no regular files")
	}
	sort.Slice(s.files, func(i, j int) bool { return s.files[i].Path < s.files[j].Path })
	ok = true
	return s, nil
}

func safeRelativePath(path string) bool {
	return path != "" && len(path) <= 4096 && !filepath.IsAbs(path) && filepath.Clean(path) == path &&
		path != "." && path != ".." && !strings.HasPrefix(path, "../") && !strings.ContainsAny(path, "\x00\r\n\\")
}

var headerName = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

func validatePlan(plan uploadPlan, s *snapshot, token string) error {
	if len(plan.Uploads) != len(s.files) {
		return errors.New("upload plan does not match manifest")
	}
	seen := map[string]bool{}
	sizes := map[string]int64{}
	for _, f := range s.files {
		sizes[f.Path] = f.Size
	}
	for _, u := range plan.Uploads {
		if _, ok := s.staged[u.Path]; !ok || seen[u.Path] || !safeRelativePath(u.Path) {
			return errors.New("unexpected or duplicate upload path")
		}
		seen[u.Path] = true
		if _, err := validHTTPURL(u.URL, false); err != nil {
			return errors.New("unsafe upload URL")
		}
		if strings.Contains(u.URL, token) {
			return errors.New("upload URL contains runtime credential")
		}
		if len(u.Headers) > 32 {
			return errors.New("upload header count exceeds limit")
		}
		bytes := 0
		headerSeen := map[string]bool{}
		for key, value := range u.Headers {
			lower := strings.ToLower(key)
			bytes += len(key) + len(value)
			if !headerName.MatchString(key) || headerSeen[lower] || bytes > 32768 ||
				strings.ContainsAny(value, "\r\n\x00") || strings.Contains(value, token) {
				return errors.New("unsafe upload header")
			}
			headerSeen[lower] = true
			switch lower {
			case "authorization", "proxy-authorization", "cookie", "host", "connection", "proxy-connection",
				"transfer-encoding", "trailer", "upgrade", "te", "keep-alive":
				return errors.New("forbidden upload header")
			case "content-length":
				size, err := strconv.ParseInt(value, 10, 64)
				if err != nil || size != sizes[u.Path] {
					return errors.New("upload content length does not match manifest")
				}
			}
			for _, c := range value {
				if (c < 32 && c != '\t') || c == 127 {
					return errors.New("unsafe upload header value")
				}
			}
		}
	}
	return nil
}

func (r *runner) publish(ctx context.Context, cp checkpoint) error {
	s, err := takeSnapshot(ctx, cp, r.contract.OutputPath)
	if err != nil {
		return err
	}
	defer os.RemoveAll(s.directory)
	request := publication{Files: s.files, Purpose: "checkpoint", Destination: cp.URL}
	var plan uploadPlan
	if err := r.broker.request(ctx, http.MethodPost, "/runtime/uploads", request, &plan, 200); err != nil {
		return err
	}
	if err := validatePlan(plan, s, r.broker.token); err != nil {
		return err
	}
	for _, u := range plan.Uploads {
		if err := r.broker.put(ctx, u, s.staged[u.Path]); err != nil {
			return err
		}
	}
	if err := r.broker.request(ctx, http.MethodPost, "/runtime/uploads/complete", request, nil, 0); err != nil {
		return failure("checkpoint completion rejected", err)
	}
	return nil
}

func (b *broker) put(ctx context.Context, u upload, path string) error {
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
		file, err := os.Open(path)
		if err != nil {
			return errors.New("cannot reopen checkpoint snapshot")
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			file.Close()
			return errors.New("invalid checkpoint snapshot")
		}
		callCtx, cancel := context.WithTimeout(ctx, b.opts.putTimeout)
		req, err := http.NewRequestWithContext(callCtx, http.MethodPut, u.URL, file)
		if err != nil {
			cancel()
			file.Close()
			return errors.New("cannot create upload request")
		}
		req.ContentLength = info.Size()
		for k, v := range u.Headers {
			req.Header.Set(k, v)
		}
		res, err := b.http.Do(req)
		if err != nil {
			file.Close()
			cancel()
			last = errors.New("checkpoint upload transport or timeout failure")
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
		res.Body.Close()
		file.Close()
		cancel()
		if len(body) > maxResponseBytes {
			return errors.New("upload response exceeds size limit")
		}
		if readErr != nil {
			last = errors.New("cannot read upload response")
			continue
		}
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			return nil
		}
		last = fmt.Errorf("checkpoint PUT returned HTTP %d", res.StatusCode)
		if res.StatusCode != 429 && res.StatusCode < 500 {
			return last
		}
	}
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	return last
}
