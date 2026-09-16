package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func checkpointContract(t *testing.T, root string) string {
	t.Helper()
	data, _ := json.Marshal(map[string]any{
		"workflowId": "r", "task": "trainer", "attempt": 1,
		"checkpoint": []map[string]string{{"path": root, "url": "s3://bucket/prefix", "frequency": "1s", "regex": `\.pt$`}},
	})
	return string(data)
}

func TestCheckpointPublishesSnapshotAndChecksumThenCompletes(t *testing.T) {
	// Catches direct re-reading after the manifest, leaked auth, and publication
	// before all PUTs complete.
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "weights"), 0700)
	path := filepath.Join(dir, "weights", "model.pt")
	os.WriteFile(path, []byte("original checkpoint"), 0600)
	os.WriteFile(filepath.Join(dir, "ignored.txt"), []byte("ignore"), 0600)
	os.Symlink("/etc/passwd", filepath.Join(dir, "escape.pt"))
	var puts, completes atomic.Int32
	var manifest publication
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PUT" || r.Header.Get("Authorization") != "" {
			t.Error("invalid PUT or leaked bearer")
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "original checkpoint" {
			t.Errorf("not snapshot bytes: %q", body)
		}
		if r.Header.Get("X-Amz-Checksum-Sha256") != base64SHA("original checkpoint") {
			t.Error("upload headers missing")
		}
		puts.Add(1)
		w.WriteHeader(200)
	}))
	defer storage.Close()
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Error("missing scoped bearer")
		}
		switch r.URL.Path {
		case "/runtime/uploads":
			if err := json.NewDecoder(r.Body).Decode(&manifest); err != nil {
				t.Error(err)
			}
			if manifest.Purpose != "checkpoint" || manifest.Destination != "s3://bucket/prefix" || len(manifest.Files) != 1 {
				t.Errorf("manifest: %+v", manifest)
			} else if f := manifest.Files[0]; f.Path != "weights/model.pt" || f.Size != 19 || f.ChecksumSHA256 != base64SHA("original checkpoint") {
				t.Errorf("bad file metadata: %+v", f)
			}
			os.WriteFile(path, []byte("changed after manifest"), 0600)
			json.NewEncoder(w).Encode(map[string]any{"uploads": []map[string]any{{"path": "weights/model.pt", "url": storage.URL, "headers": map[string]string{"x-amz-checksum-sha256": base64SHA("original checkpoint")}}}})
		case "/runtime/uploads/complete":
			if puts.Load() != 1 {
				t.Error("completed before upload")
			}
			var got publication
			json.NewDecoder(r.Body).Decode(&got)
			if len(got.Files) != 1 || got.Files[0].ChecksumSHA256 != base64SHA("original checkpoint") {
				t.Error("completion manifest changed")
			}
			completes.Add(1)
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
	defer broker.Close()
	var out, log bytes.Buffer
	r := testRunner(t, broker.URL, checkpointContract(t, dir), &out, &log)
	if err := r.publish(context.Background(), r.contract.Checkpoint[0]); err != nil {
		t.Fatal(err)
	}
	if puts.Load() != 1 || completes.Load() != 1 {
		t.Fatal("publication not completed")
	}
}

func base64SHA(s string) string {
	sum := sha256.Sum256([]byte(s))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func TestCheckpointRejectsInvalidPlansAndUploadFailures(t *testing.T) {
	for _, mode := range []string{"missing", "duplicate", "extra", "unsafe-url", "unsafe-header", "oversized", "put-fails", "complete-fails", "fenced"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			os.WriteFile(filepath.Join(dir, "x.pt"), []byte("abc"), 0600)
			var puts, completed atomic.Int32
			storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				puts.Add(1)
				if mode == "put-fails" {
					w.WriteHeader(503)
				} else {
					w.WriteHeader(200)
				}
			}))
			defer storage.Close()
			b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/runtime/uploads":
					entry := map[string]any{"path": "x.pt", "url": storage.URL}
					uploads := []map[string]any{entry}
					switch mode {
					case "missing":
						uploads = nil
					case "duplicate":
						uploads = append(uploads, entry)
					case "extra":
						uploads = append(uploads, map[string]any{"path": "../escape", "url": storage.URL})
					case "unsafe-url":
						entry["url"] = "file:///tmp/stolen"
					case "unsafe-header":
						entry["headers"] = map[string]string{"Authorization": "Bearer test-secret"}
					case "oversized":
						w.Write([]byte(strings.Repeat(" ", 2*1024*1024+1)))
						return
					case "fenced":
						w.WriteHeader(410)
						return
					}
					json.NewEncoder(w).Encode(map[string]any{"uploads": uploads})
				case "/runtime/uploads/complete":
					completed.Add(1)
					w.WriteHeader(403)
				default:
					w.WriteHeader(404)
				}
			}))
			defer b.Close()
			var out, log bytes.Buffer
			r := testRunner(t, b.URL, checkpointContract(t, dir), &out, &log)
			if err := r.publish(context.Background(), r.contract.Checkpoint[0]); err == nil {
				t.Fatal("reported false publication success")
			} else if strings.Contains(err.Error(), "test-secret") || strings.Contains(err.Error(), storage.URL) {
				t.Fatal("sensitive error")
			}
			if mode != "put-fails" && mode != "complete-fails" && puts.Load() != 0 {
				t.Fatal("uploaded before validating entire plan")
			}
			if mode != "complete-fails" && completed.Load() != 0 {
				t.Fatal("completed failed upload")
			}
		})
	}
}

func TestCheckpointRejectsOversizeAndSymlinkRootWithoutBrokerCall(t *testing.T) {
	for _, mode := range []string{"oversize", "symlink-root", "empty"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			root := dir
			if mode == "oversize" {
				f, err := os.Create(filepath.Join(dir, "huge.pt"))
				if err != nil {
					t.Fatal(err)
				}
				if err := f.Truncate(5*1024*1024*1024 + 1); err != nil {
					t.Fatal(err)
				}
				f.Close()
			}
			if mode == "symlink-root" {
				root = filepath.Join(t.TempDir(), "link")
				os.Symlink(dir, root)
			}
			b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected broker call"); w.WriteHeader(500) }))
			defer b.Close()
			var out, log bytes.Buffer
			r := testRunner(t, b.URL, checkpointContract(t, root), &out, &log)
			err := r.publish(context.Background(), r.contract.Checkpoint[0])
			if err == nil {
				t.Fatal("unsafe checkpoint accepted")
			}
			if mode == "oversize" && !strings.Contains(err.Error(), "multipart") {
				t.Fatalf("unclear size error: %v", err)
			}
		})
	}
}

func TestRequiredFinalCheckpointFailureOverridesSuccessfulWorkload(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "x.pt"), []byte("data"), 0600)
	var terminal stateReport
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/runtime/state":
			json.NewDecoder(r.Body).Decode(&terminal)
			w.WriteHeader(204)
		case "/runtime/heartbeat":
			w.WriteHeader(204)
		case "/runtime/barrier":
			w.Write([]byte(`{"released":true}`))
		case "/runtime/uploads":
			w.WriteHeader(503)
		default:
			w.WriteHeader(404)
		}
	}))
	defer b.Close()
	var out, log bytes.Buffer
	r := testRunner(t, b.URL, checkpointContract(t, dir), &out, &log)
	if code := r.run(context.Background(), []string{"/bin/sh", "-c", "exit 0"}); code != 125 {
		t.Fatalf("false success: %d", code)
	}
	if terminal.Phase != "FAILED" || terminal.ExitCode == nil || *terminal.ExitCode != 0 || !strings.HasPrefix(terminal.Message, "runtime-error: final checkpoint") {
		t.Fatalf("lost final failure or raw exit: %+v", terminal)
	}
}

func TestPeriodicCheckpointAndFinalPublication(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "x.pt"), []byte("data"), 0600)
	var publications atomic.Int32
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); w.WriteHeader(200) }))
	defer storage.Close()
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/runtime/state", "/runtime/heartbeat":
			w.WriteHeader(204)
		case "/runtime/barrier":
			w.Write([]byte(`{"released":true}`))
		case "/runtime/uploads":
			json.NewEncoder(w).Encode(map[string]any{"uploads": []map[string]string{{"path": "x.pt", "url": storage.URL}}})
		case "/runtime/uploads/complete":
			publications.Add(1)
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
	defer b.Close()
	var out, log bytes.Buffer
	r := testRunner(t, b.URL, checkpointContract(t, dir), &out, &log)
	r.contract.Checkpoint[0].interval = 30 * time.Millisecond
	if code := r.run(context.Background(), []string{"/bin/sh", "-c", "sleep .2"}); code != 0 {
		t.Fatalf("exit %d: %s", code, log.String())
	}
	if publications.Load() < 2 {
		t.Fatal("periodic and final checkpoints not both published")
	}
}

func TestCheckpointScratchStaysOutsideServedRootAndSkipsUploadStaging(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TMPDIR", root)
	os.WriteFile(filepath.Join(root, "model.pt"), []byte("abc"), 0600)
	os.WriteFile(filepath.Join(root, ".pai-files-upload-private.pt"), []byte("incomplete"), 0600)
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); w.WriteHeader(200) }))
	defer storage.Close()
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/runtime/uploads" {
			entries, _ := os.ReadDir(root)
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), "pai-checkpoint-") {
					t.Error("private checkpoint scratch is inside browser root")
				}
			}
			var p publication
			json.NewDecoder(r.Body).Decode(&p)
			if len(p.Files) != 1 || p.Files[0].Path != "model.pt" {
				t.Errorf("checkpoint includes runtime staging: %+v", p.Files)
			}
			json.NewEncoder(w).Encode(uploadPlan{Uploads: []upload{{Path: "model.pt", URL: storage.URL}}})
		} else {
			w.WriteHeader(204)
		}
	}))
	defer b.Close()
	var out, log bytes.Buffer
	r := testRunner(t, b.URL, checkpointContract(t, root), &out, &log)
	r.contract.OutputPath = root
	if err := r.publish(context.Background(), r.contract.Checkpoint[0]); err != nil {
		t.Fatal(err)
	}
}
