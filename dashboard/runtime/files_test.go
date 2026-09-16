package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func filesFixture(t *testing.T, root string, limit int64) (*fileHandler, *httptest.Server, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	options := defaultFileOptions()
	options.maxBytes = limit
	options.transferTimeout = 2 * time.Second
	h, err := newFileHandler(ctx, root, options)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	s := httptest.NewServer(h)
	t.Cleanup(func() { cancel(); s.Close(); h.Close() })
	return h, s, cancel
}

func fileRequest(t *testing.T, client *http.Client, method, url string, body io.Reader) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatal(err)
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func TestFilesUploadListDownloadAndNoDelete(t *testing.T) {
	root := t.TempDir()
	_, s, _ := filesFixture(t, root, 1024)
	name := `weights "v1" <safe>.bin`
	relative := "models/" + name
	res := fileRequest(t, s.Client(), "PUT", s.URL+"/files/"+url.PathEscape("models")+"/"+url.PathEscape(name), strings.NewReader("checkpoint bytes"))
	if res.StatusCode != 204 {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("PUT %d: %s", res.StatusCode, body)
	}
	res = fileRequest(t, s.Client(), "GET", s.URL+"/api/files?path=models", nil)
	var listing fileListing
	if err := json.NewDecoder(res.Body).Decode(&listing); err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 || listing.Path != "models" || len(listing.Entries) != 1 ||
		listing.Entries[0].Name != name || listing.Entries[0].Path != relative || listing.Entries[0].Type != "file" ||
		listing.Entries[0].Size != 16 || listing.MaxUploadBytes != 1024 {
		t.Fatalf("listing: %+v", listing)
	}
	res = fileRequest(t, s.Client(), "GET", s.URL+"/files/models/"+url.PathEscape(name), nil)
	data, err := io.ReadAll(res.Body)
	if err != nil || string(data) != "checkpoint bytes" || res.Header.Get("Content-Type") != "application/octet-stream" ||
		!strings.HasPrefix(res.Header.Get("Content-Disposition"), "attachment;") {
		t.Fatalf("download %q %v headers=%v", data, err, res.Header)
	}
	res = fileRequest(t, s.Client(), "DELETE", s.URL+"/files/models/"+url.PathEscape(name), nil)
	if res.StatusCode != 405 {
		t.Fatalf("deletion returned %d", res.StatusCode)
	}
	if data, err := os.ReadFile(filepath.Join(root, relative)); err != nil || string(data) != "checkpoint bytes" {
		t.Fatal("DELETE changed user data")
	}
	res = fileRequest(t, s.Client(), "GET", s.URL+"/", nil)
	html, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || !strings.Contains(string(html), "Upload") || res.Header.Get("Content-Security-Policy") == "" ||
		bytes.Contains(html, []byte(name)) {
		t.Fatal("browser missing, unsafe, or interpolates user names")
	}
}

func TestFilesRejectTraversalSymlinksHardlinksSpecialAndReservedNames(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret")
	os.WriteFile(secret, []byte("outside data"), 0600)
	os.Symlink(outside, filepath.Join(root, "escape"))
	os.Symlink(secret, filepath.Join(root, "link"))
	if err := os.Link(secret, filepath.Join(root, "hardlink")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(root, "pipe"), 0600); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(root, ".pai-input-receipt.json"), []byte("private"), 0600)
	os.Mkdir(filepath.Join(root, "pai-checkpoint-private"), 0700)
	_, s, _ := filesFixture(t, root, 1024)
	for _, path := range []string{"../secret", "/absolute", "x/../secret", "x//file", "x\\file", "x/\x00bad", "x/\tbad", "x/\x7fbad",
		"escape/secret", "link", "hardlink", "pipe", ".pai-input-receipt.json", ".pai-files-upload-private", "pai-checkpoint-private/secret"} {
		for _, method := range []string{"GET", "PUT"} {
			res := fileRequest(t, s.Client(), method, s.URL+"/files/"+url.PathEscape(path), strings.NewReader("overwrite"))
			if res.StatusCode < 400 {
				t.Errorf("accepted %s %q: %d", method, path, res.StatusCode)
			}
		}
		res := fileRequest(t, s.Client(), "GET", s.URL+"/api/files?path="+url.QueryEscape(path), nil)
		if res.StatusCode < 400 {
			t.Errorf("listed unsafe path %q", path)
		}
	}
	res := fileRequest(t, s.Client(), "GET", s.URL+"/api/files", nil)
	var listing fileListing
	json.NewDecoder(res.Body).Decode(&listing)
	if len(listing.Entries) != 0 {
		t.Fatalf("exposed unsafe entries: %+v", listing.Entries)
	}
	if data, _ := os.ReadFile(secret); string(data) != "outside data" {
		t.Fatal("escaped root and overwrote outside file")
	}
}

func TestFileRootRejectsSymlinkAncestors(t *testing.T) {
	outside := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	os.Symlink(outside, link)
	for _, root := range []string{link, filepath.Join(link, "child"), "/"} {
		h, err := newFileHandler(context.Background(), root, defaultFileOptions())
		if err == nil {
			h.Close()
			t.Fatalf("accepted unsafe root %q", root)
		}
	}
}

func TestFilesOversizeAndCancelledUploadPreserveExistingTarget(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "data.bin")
	os.WriteFile(path, []byte("original"), 0600)
	_, s, cancel := filesFixture(t, root, 8)
	for _, body := range []io.Reader{strings.NewReader("too many bytes"), io.LimitReader(strings.NewReader("too many bytes"), 14)} {
		res := fileRequest(t, s.Client(), "PUT", s.URL+"/files/data.bin", body)
		if res.StatusCode != 413 {
			t.Fatalf("oversize PUT: %d", res.StatusCode)
		}
		if data, _ := os.ReadFile(path); string(data) != "original" {
			t.Fatal("oversize upload replaced target")
		}
	}
	reader, writer := io.Pipe()
	req, _ := http.NewRequest("PUT", s.URL+"/files/data.bin", reader)
	done := make(chan struct{})
	go func() {
		defer close(done)
		res, _ := s.Client().Do(req)
		if res != nil {
			res.Body.Close()
		}
	}()
	writer.Write([]byte("partial"))
	eventually(t, func() bool {
		entries, _ := os.ReadDir(root)
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".pai-files-upload-") {
				return true
			}
		}
		return false
	})
	cancel()
	writer.Close()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("upload did not cancel")
	}
	eventually(t, func() bool { entries, _ := os.ReadDir(root); return len(entries) == 1 })
	if data, _ := os.ReadFile(path); string(data) != "original" {
		t.Fatal("cancelled upload replaced target")
	}
}

func TestConcurrentFileWritesCommitWholeFiles(t *testing.T) {
	root := t.TempDir()
	_, s, _ := filesFixture(t, root, 1<<20)
	bodies := []string{strings.Repeat("a", 65536), strings.Repeat("b", 65536), strings.Repeat("c", 65536), strings.Repeat("d", 65536)}
	var workers sync.WaitGroup
	for _, body := range bodies {
		workers.Add(1)
		go func(body string) {
			defer workers.Done()
			req, _ := http.NewRequest("PUT", s.URL+"/files/result", strings.NewReader(body))
			res, err := s.Client().Do(req)
			if err != nil {
				t.Error(err)
				return
			}
			defer res.Body.Close()
			if res.StatusCode != 204 {
				t.Errorf("concurrent PUT %d", res.StatusCode)
			}
		}(body)
	}
	workers.Wait()
	data, err := os.ReadFile(filepath.Join(root, "result"))
	if err != nil {
		t.Fatal(err)
	}
	match := false
	for _, body := range bodies {
		match = match || string(data) == body
	}
	if !match {
		t.Fatal("concurrent uploads produced mixed or truncated bytes")
	}
}

func TestFilesListenerIsLoopbackAndClosesOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	o := defaultFileOptions()
	o.address = "127.0.0.1:0"
	s, err := startFileService(ctx, t.TempDir(), o, func(err error) { t.Error(err) })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	address := s.listener.Addr().(*net.TCPAddr)
	if !address.IP.Equal(net.IPv4(127, 0, 0, 1)) {
		t.Fatal("file service has a public listener")
	}
	res := fileRequest(t, http.DefaultClient, "GET", "http://"+address.String()+"/api/files", nil)
	if res.StatusCode != 200 {
		t.Fatal("file listener did not serve")
	}
	cancel()
	eventually(t, func() bool {
		conn, err := net.DialTimeout("tcp", address.String(), 20*time.Millisecond)
		if conn != nil {
			conn.Close()
		}
		return err != nil
	})
	for _, address := range []string{"0.0.0.0:8077", ":8077", "[::]:8077", "192.168.1.2:8077"} {
		o.address = address
		s, err := startFileService(context.Background(), t.TempDir(), o, func(error) {})
		if err == nil {
			s.Close()
			t.Fatalf("allowed nonloopback bind %s", address)
		}
	}
}

func TestRuntimeFilesStopOnNormalExitAndFencing(t *testing.T) {
	for _, fence := range []bool{false, true} {
		t.Run(map[bool]string{false: "normal", true: "fenced"}[fence], func(t *testing.T) {
			f := newFixture(t)
			f.released.Store(true)
			root := t.TempDir()
			raw, _ := json.Marshal(map[string]any{"workflowId": "r", "task": "trainer", "attempt": 1, "outputPath": root})
			var out, log bytes.Buffer
			r := testRunner(t, f.server.URL, string(raw), &out, &log)
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			done := make(chan int, 1)
			go func() {
				done <- r.run(ctx, []string{"/bin/sh", "-c", `while [ ! -e "$1/stop" ]; do sleep .01; done`, "sh", root})
			}()
			client := &http.Client{Timeout: 100 * time.Millisecond}
			eventually(t, func() bool {
				res, err := client.Get("http://127.0.0.1:8077/api/files")
				if res != nil {
					res.Body.Close()
				}
				return err == nil && res.StatusCode == 200
			})
			if fence {
				f.fenced.Store(true)
			} else {
				res := fileRequest(t, client, "PUT", "http://127.0.0.1:8077/files/stop", strings.NewReader("finish"))
				if res.StatusCode != 204 {
					t.Fatal("runtime file PUT failed")
				}
			}
			want := 0
			if fence {
				want = 125
			}
			if code := <-done; code != want {
				t.Fatalf("exit %d: %s", code, log.String())
			}
			conn, err := net.DialTimeout("tcp", "127.0.0.1:8077", 20*time.Millisecond)
			if conn != nil {
				conn.Close()
			}
			if err == nil {
				t.Fatal("file listener survived runtime exit/fence")
			}
		})
	}
}

func TestFileDownloadStopsWhenServiceIsCancelled(t *testing.T) {
	root := t.TempDir()
	file, err := os.Create(filepath.Join(root, "large.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(32 * 1024 * 1024); err != nil {
		t.Fatal(err)
	}
	file.Close()
	handler, s, cancel := filesFixture(t, root, 1024)
	res := fileRequest(t, s.Client(), "GET", s.URL+"/files/large.bin", nil)
	var first [1]byte
	if _, err := res.Body.Read(first[:]); err != nil {
		t.Fatal(err)
	}
	cancel()
	closed := make(chan struct{})
	go func() { handler.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled download blocked handler shutdown")
	}
	if n, err := io.Copy(io.Discard, res.Body); err == nil || n >= 32*1024*1024-1 {
		t.Fatal("download continued to completion after cancellation")
	}
}

func TestFileUploadLimitEnvironmentIsBounded(t *testing.T) {
	for _, value := range []string{"0", "-1", "5368709121", "infinity", "01"} {
		t.Setenv("PAI_RUNTIME_FILES_MAX_BYTES", value)
		if _, err := fileOptionsFromEnvironment(); err == nil {
			t.Fatalf("unsafe upload limit accepted: %s", value)
		}
	}
	t.Setenv("PAI_RUNTIME_FILES_MAX_BYTES", "4096")
	opts, err := fileOptionsFromEnvironment()
	if err != nil || opts.maxBytes != 4096 {
		t.Fatalf("configured upload limit ignored: %+v %v", opts, err)
	}
}

func TestFilesDisabledEnvironmentRejectsInvalidValues(t *testing.T) {
	for _, value := range []string{"", "0", "true", "false", "01", " 1"} {
		t.Setenv("PAI_RUNTIME_FILES_DISABLED", value)
		if _, err := fileOptionsFromEnvironment(); err == nil {
			t.Fatalf("invalid disable flag accepted: %q", value)
		}
	}
	t.Setenv("PAI_RUNTIME_FILES_DISABLED", "1")
	options, err := fileOptionsFromEnvironment()
	if err != nil || !options.disabled {
		t.Fatalf("disable flag ignored: %+v %v", options, err)
	}
}

func TestFilesDisabledRunsChildWithoutBindingOccupiedPort(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:8077")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	f := newFixture(t)
	f.released.Store(true)
	t.Setenv("PAI_RUNTIME_ENDPOINT", f.server.URL)
	t.Setenv("PAI_RUNTIME_TOKEN", "test-secret")
	t.Setenv("OSMO_TASK_REPLICA_INDEX", "0")
	t.Setenv("PAI_RUNTIME_FILES_DISABLED", "1")
	raw, _ := json.Marshal(map[string]any{"workflowId": "r", "task": "trainer", "attempt": 1, "outputPath": t.TempDir()})
	var out, logs bytes.Buffer
	code := runCLI(context.Background(), []string{"--contract", string(raw), "--", "/bin/sh", "-c", "printf child-ran"},
		nil, &out, &logs, func(context.Context) error { return nil })
	if code != 0 || out.String() != "child-ran" {
		t.Fatalf("disabled service attempted to bind or blocked child: %d %s %s", code, out.String(), logs.String())
	}
}

func TestPrepareInputsDoesNotStartFilesEvenWithOutputPath(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:8077")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/runtime/inputs" {
			w.Write([]byte(`{"inputs":[]}`))
		} else if r.URL.Path == "/runtime/heartbeat" {
			w.WriteHeader(204)
		} else {
			t.Error("unexpected preparation request")
			w.WriteHeader(404)
		}
	}))
	defer b.Close()
	t.Setenv("PAI_RUNTIME_ENDPOINT", b.URL)
	t.Setenv("PAI_RUNTIME_TOKEN", "test-secret")
	t.Setenv("OSMO_TASK_REPLICA_INDEX", "0")
	t.Setenv("PAI_RUNTIME_FILES_MAX_BYTES", "invalid-unused-in-init")
	raw, _ := json.Marshal(map[string]any{"workflowId": "r", "task": "trainer", "attempt": 1, "outputPath": t.TempDir()})
	var output bytes.Buffer
	if code := runCLI(context.Background(), []string{"--prepare-inputs", "--contract", string(raw)}, nil, &output, &output, func(context.Context) error { return nil }); code != 0 {
		t.Fatalf("init started file service or read its config: %d %s", code, output.String())
	}
}

func TestFileBindFailurePreventsWorkloadStart(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:8077")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	f := newFixture(t)
	f.released.Store(true)
	root := t.TempDir()
	raw, _ := json.Marshal(map[string]any{"workflowId": "r", "task": "trainer", "attempt": 1, "outputPath": root})
	var out, log bytes.Buffer
	r := testRunner(t, f.server.URL, string(raw), &out, &log)
	if code := r.run(context.Background(), []string{"/bin/sh", "-c", `touch "$1/started"`, "sh", root}); code != 125 {
		t.Fatalf("bind failure was not fatal: %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "started")); !os.IsNotExist(err) {
		t.Fatal("workload ran without required file listener")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	last := f.states[len(f.states)-1]
	if last.Phase != "FAILED" || last.ExitCode != nil || !strings.HasPrefix(last.Message, "runtime-error:") {
		t.Fatalf("bind failure report lost: %+v", last)
	}
}
