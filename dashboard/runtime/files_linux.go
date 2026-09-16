package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

const maxFileListingEntries = 4096

type fileEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modifiedAt"`
}
type fileListing struct {
	Path           string      `json:"path"`
	Entries        []fileEntry `json:"entries"`
	MaxUploadBytes int64       `json:"maxUploadBytes"`
}
type fileHandler struct {
	root      *os.File
	ctx       context.Context
	cancel    context.CancelFunc
	opts      fileOptions
	mu        sync.Mutex // serializes shutdown with upload commits and request admission
	closing   bool
	requests  sync.WaitGroup
	closeOnce sync.Once
	active    chan struct{}
	uploads   chan struct{}
}
type fileHTTPError struct {
	status  int
	message string
}

func (e *fileHTTPError) Error() string           { return e.message }
func fileError(status int, message string) error { return &fileHTTPError{status, message} }

func reservedRuntimeName(name string) bool {
	return strings.HasPrefix(name, ".pai-") || strings.HasPrefix(name, "pai-checkpoint-")
}

func filePathAllowed(path string, allowRoot bool) bool {
	if path == "" {
		return allowRoot
	}
	if !utf8.ValidString(path) || !safeRelativePath(path) || len(strings.Split(path, "/")) > 64 {
		return false
	}
	for _, r := range path {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	for _, part := range strings.Split(path, "/") {
		if reservedRuntimeName(part) {
			return false
		}
	}
	return true
}

func newFileHandler(parent context.Context, root string, opts fileOptions) (*fileHandler, error) {
	if parent.Err() != nil {
		return nil, context.Cause(parent)
	}
	if !safeAbsolutePath(root) || !filePathAllowed(strings.TrimPrefix(strings.TrimSuffix(root, "/"), "/"), false) ||
		opts.maxBytes < 1 || opts.maxBytes > maxFileBytes || opts.transferTimeout <= 0 {
		return nil, errors.New("invalid file service root or limits")
	}
	dir, err := openCheckpointRoot(root)
	if err != nil {
		return nil, errors.New("file service root is missing, unreadable, or contains a symlink")
	}
	info, err := dir.Stat()
	if err != nil || !info.IsDir() {
		dir.Close()
		return nil, errors.New("file service root must be a directory")
	}
	ctx, cancel := context.WithCancel(parent)
	return &fileHandler{root: dir, ctx: ctx, cancel: cancel, opts: opts, active: make(chan struct{}, 16), uploads: make(chan struct{}, 4)}, nil
}

func (f *fileHandler) beginClose() {
	f.mu.Lock()
	f.closing = true
	f.cancel()
	f.mu.Unlock()
}
func (f *fileHandler) Close() {
	f.closeOnce.Do(func() { f.beginClose(); f.requests.Wait(); f.root.Close() })
}

func writeFileError(w http.ResponseWriter, err error) {
	status, message := http.StatusInternalServerError, "file operation failed"
	var reported *fileHTTPError
	if errors.As(err, &reported) {
		status, message = reported.status, reported.message
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func (f *fileHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	f.mu.Lock()
	if f.closing || f.ctx.Err() != nil {
		f.mu.Unlock()
		writeFileError(w, fileError(410, "file service stopped"))
		return
	}
	f.requests.Add(1)
	f.mu.Unlock()
	defer f.requests.Done()
	select {
	case f.active <- struct{}{}:
		defer func() { <-f.active }()
	default:
		writeFileError(w, fileError(429, "file service busy"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), f.opts.transferTimeout)
	defer cancel()
	stop := context.AfterFunc(f.ctx, cancel)
	defer stop()
	controller := http.NewResponseController(w)
	body := r.Body
	interrupted := make(chan struct{})
	interrupt := context.AfterFunc(ctx, func() {
		defer close(interrupted)
		controller.SetReadDeadline(time.Now())
		controller.SetWriteDeadline(time.Now())
		if body != nil {
			body.Close()
		}
	})
	defer func() {
		if !interrupt() {
			<-interrupted
		}
	}()
	r = r.WithContext(ctx)
	if len(r.URL.Path) > 4104 || len(r.URL.RawQuery) > 16384 {
		writeFileError(w, fileError(400, "request path exceeds limit"))
		return
	}
	switch {
	case r.URL.Path == "/":
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeFileError(w, fileError(405, "method not allowed"))
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", fileBrowserCSP())
		io.WriteString(w, fileBrowserHTML())
	case r.URL.Path == "/api/files":
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeFileError(w, fileError(405, "method not allowed"))
			return
		}
		query, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil || len(query) > 1 || (len(query) == 1 && len(query["path"]) != 1) {
			writeFileError(w, fileError(400, "invalid listing query"))
			return
		}
		path := query.Get("path")
		if !filePathAllowed(path, true) {
			writeFileError(w, fileError(400, "unsafe file path"))
			return
		}
		data, err := f.list(ctx, path)
		if err != nil {
			writeFileError(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Write(data)
	case strings.HasPrefix(r.URL.Path, "/files/"):
		if r.Method != http.MethodGet && r.Method != http.MethodPut {
			w.Header().Set("Allow", "GET, PUT")
			writeFileError(w, fileError(405, "method not allowed"))
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/files/")
		if !filePathAllowed(path, false) || r.URL.RawQuery != "" {
			writeFileError(w, fileError(400, "unsafe file path"))
			return
		}
		if r.Method == http.MethodGet {
			f.download(w, r, path)
			return
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			writeFileError(w, fileError(403, "cross-site upload forbidden"))
			return
		}
		select {
		case f.uploads <- struct{}{}:
			defer func() { <-f.uploads }()
		default:
			writeFileError(w, fileError(429, "upload service busy"))
			return
		}
		if err := f.upload(w, r, path); err != nil {
			writeFileError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		writeFileError(w, fileError(404, "route not found"))
	}
}

func (f *fileHandler) directory(path string, create bool) (*os.File, error) {
	fd, err := syscall.Openat(int(f.root.Fd()), ".", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, fileError(500, "cannot open file root")
	}
	dir := os.NewFile(uintptr(fd), "files-directory")
	if path == "" {
		return dir, nil
	}
	for _, part := range strings.Split(path, "/") {
		flags := syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
		next, err := syscall.Openat(int(dir.Fd()), part, flags, 0)
		if err == syscall.ENOENT && create {
			if err = syscall.Mkdirat(int(dir.Fd()), part, 0755); err == nil || err == syscall.EEXIST {
				next, err = syscall.Openat(int(dir.Fd()), part, flags, 0)
			}
		}
		dir.Close()
		if err != nil {
			if err == syscall.ENOENT {
				return nil, fileError(404, "directory not found")
			}
			return nil, fileError(403, "directory is unsafe or inaccessible")
		}
		dir = os.NewFile(uintptr(next), "files-directory")
	}
	return dir, nil
}

func (f *fileHandler) parent(path string, create bool) (*os.File, string, error) {
	dirPath := filepath.Dir(path)
	if dirPath == "." {
		dirPath = ""
	}
	dir, err := f.directory(dirPath, create)
	return dir, filepath.Base(path), err
}

func unlinkedRegular(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return info.Mode().IsRegular() && ok && stat.Nlink == 1
}

func openBrowserFile(parent *os.File, name string) (*os.File, os.FileInfo, error) {
	fd, err := syscall.Openat(int(parent.Fd()), name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		if err == syscall.ENOENT {
			return nil, nil, fileError(404, "file not found")
		}
		return nil, nil, fileError(403, "file is unsafe or inaccessible")
	}
	file := os.NewFile(uintptr(fd), "browser-file")
	info, err := file.Stat()
	if err != nil || !unlinkedRegular(info) {
		file.Close()
		return nil, nil, fileError(403, "file must be regular and have one hard link")
	}
	return file, info, nil
}

func (f *fileHandler) list(ctx context.Context, path string) ([]byte, error) {
	dir, err := f.directory(path, false)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	listing := fileListing{Path: path, Entries: []fileEntry{}, MaxUploadBytes: f.opts.maxBytes}
	estimated := 0
	for {
		if ctx.Err() != nil {
			return nil, fileError(408, "listing cancelled")
		}
		entries, readErr := dir.ReadDir(128)
		if readErr != nil && readErr != io.EOF {
			return nil, fileError(500, "cannot list directory")
		}
		for _, entry := range entries {
			relative := entry.Name()
			if path != "" {
				relative = path + "/" + relative
			}
			if !filePathAllowed(relative, false) || entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			if entry.Type() != 0 && !entry.IsDir() {
				continue
			}
			fd, err := syscall.Openat(int(dir.Fd()), entry.Name(), syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
			if err != nil {
				continue
			}
			child := os.NewFile(uintptr(fd), "listing-entry")
			stat, err := child.Stat()
			child.Close()
			if err != nil || (!stat.IsDir() && !unlinkedRegular(stat)) {
				continue
			}
			record := fileEntry{Name: entry.Name(), Path: relative, Type: "file", Size: stat.Size(), ModifiedAt: stat.ModTime().UTC().Format(time.RFC3339Nano)}
			if stat.IsDir() {
				record.Type = "directory"
				record.Size = 0
			}
			estimated += len(record.Name) + len(record.Path) + 128
			if len(listing.Entries) >= maxFileListingEntries || estimated > maxResponseBytes {
				return nil, fileError(413, "directory listing exceeds limit")
			}
			listing.Entries = append(listing.Entries, record)
		}
		if readErr == io.EOF {
			break
		}
	}
	sort.Slice(listing.Entries, func(i, j int) bool {
		a, b := listing.Entries[i], listing.Entries[j]
		if a.Type != b.Type {
			return a.Type == "directory"
		}
		return a.Name < b.Name
	})
	data, err := json.Marshal(listing)
	if err != nil || len(data) > maxResponseBytes {
		return nil, fileError(413, "directory listing exceeds limit")
	}
	return data, nil
}

func (f *fileHandler) download(w http.ResponseWriter, r *http.Request, path string) {
	parent, name, err := f.parent(path, false)
	if err != nil {
		writeFileError(w, err)
		return
	}
	defer parent.Close()
	file, info, err := openBrowserFile(parent, name)
	if err != nil {
		writeFileError(w, err)
		return
	}
	defer file.Close()
	if r.Context().Err() != nil {
		writeFileError(w, fileError(408, "download cancelled"))
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.WriteHeader(200)
	if _, err := io.CopyN(w, contextReader{ctx: r.Context(), reader: file}, info.Size()); err != nil {
		// net/http closes the response without logging paths or serving a
		// misleading successful, truncated stream.
		panic(http.ErrAbortHandler)
	}
}

func (f *fileHandler) upload(w http.ResponseWriter, r *http.Request, path string) error {
	if r.ContentLength > f.opts.maxBytes {
		return fileError(413, "upload exceeds size limit")
	}
	parent, name, err := f.parent(path, true)
	if err != nil {
		return err
	}
	defer parent.Close()
	if err := checkUploadTarget(parent, name); err != nil {
		return err
	}
	temp, tempName, err := temporaryFileAt(parent, ".pai-files-upload-")
	if err != nil {
		return fileError(500, "cannot stage upload")
	}
	defer temp.Close()
	defer syscall.Unlinkat(int(parent.Fd()), tempName)
	body := http.MaxBytesReader(w, r.Body, f.opts.maxBytes)
	n, err := io.CopyBuffer(temp, contextReader{ctx: r.Context(), reader: body}, make([]byte, 128*1024))
	if r.Context().Err() != nil || f.ctx.Err() != nil {
		return fileError(408, "upload cancelled")
	}
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return fileError(413, "upload exceeds size limit")
		}
		return fileError(400, "upload stream incomplete")
	}
	if r.ContentLength >= 0 && n != r.ContentLength {
		return fileError(400, "upload size does not match Content-Length")
	}
	if err := temp.Sync(); err != nil {
		return fileError(500, "cannot persist upload")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closing || f.ctx.Err() != nil || r.Context().Err() != nil {
		return fileError(408, "upload cancelled")
	}
	if err := checkUploadTarget(parent, name); err != nil {
		return err
	}
	if err := syscall.Renameat(int(parent.Fd()), tempName, int(parent.Fd()), name); err != nil {
		return fileError(500, "cannot commit upload")
	}
	if err := parent.Sync(); err != nil {
		return fileError(500, "cannot sync upload directory")
	}
	return nil
}

func checkUploadTarget(parent *os.File, name string) error {
	file, _, err := openBrowserFile(parent, name)
	if file != nil {
		file.Close()
	}
	var status *fileHTTPError
	if errors.As(err, &status) && status.status == 404 {
		return nil
	}
	return err
}
