package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPrepareInputsVerifiesReceiptBeforeSkipping(t *testing.T) {
	root := t.TempDir()
	destination := filepath.Join(root, "cache", "version-1")
	var gets atomic.Int32
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.Header.Get("Authorization") != "" {
			t.Error("download leaked bearer or wrong method")
		}
		gets.Add(1)
		w.Write([]byte("dataset bytes"))
	}))
	defer storage.Close()
	hash := strings.Repeat("a", 64)
	plan := map[string]any{"inputs": []map[string]any{{
		"destination": destination, "manifestHash": hash,
		"files": []map[string]any{{"path": "images/a.bin", "url": storage.URL, "size": 13,
			"checksumSHA256": base64SHA("dataset bytes"), "checksumType": "FULL_OBJECT"}},
	}}}
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Error("missing input broker bearer")
		}
		switch r.URL.Path {
		case "/runtime/inputs":
			json.NewEncoder(w).Encode(plan)
		case "/runtime/heartbeat":
			w.WriteHeader(204)
		default:
			t.Error("hydration must not post workload readiness")
			w.WriteHeader(404)
		}
	}))
	defer b.Close()
	var out, log bytes.Buffer
	makeRunner := func() *runner { r := testRunner(t, b.URL, baseContract, &out, &log); r.opts.inputRoot = root; return r }
	if code := makeRunner().prepareInputs(context.Background()); code != 0 {
		t.Fatalf("hydration exit %d: %s", code, log.String())
	}
	path := filepath.Join(destination, "images", "a.bin")
	if data, err := os.ReadFile(path); err != nil || string(data) != "dataset bytes" {
		t.Fatalf("download missing: %q %v", data, err)
	}
	marker := filepath.Join(destination, ".pai-input-receipt.json")
	data, err := os.ReadFile(marker)
	if err != nil || !bytes.Contains(data, []byte(hash)) {
		t.Fatalf("receipt absent: %s %v", data, err)
	}
	if code := makeRunner().prepareInputs(context.Background()); code != 0 {
		t.Fatalf("cached input rejected: %s", log.String())
	}
	if gets.Load() != 1 {
		t.Fatal("valid receipt did not skip download")
	}
	// Same-size corruption must be caught even with the original receipt.
	os.WriteFile(path, []byte("corrupt bytes"), 0644)
	if code := makeRunner().prepareInputs(context.Background()); code != 0 {
		t.Fatalf("cache repair failed: %s", log.String())
	}
	if gets.Load() != 2 {
		t.Fatal("trusted receipt without validating cached bytes")
	}
	os.WriteFile(marker, []byte(`{"version":1,"manifestHash":"`+strings.Repeat("b", 64)+`"}`), 0644)
	if code := makeRunner().prepareInputs(context.Background()); code != 0 {
		t.Fatalf("mismatched receipt repair failed: %s", log.String())
	}
	if gets.Load() != 3 {
		t.Fatal("skipped cache despite receipt hash mismatch")
	}
}

func TestPrepareInputsRejectsTraversalSymlinksAndBadBytes(t *testing.T) {
	for _, mode := range []string{"traversal", "symlink-parent", "checksum", "size", "duplicate", "prefix-conflict", "receipt-path", "composite", "broker-alias"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			destination := filepath.Join(root, "cache")
			outside := t.TempDir()
			os.Mkdir(destination, 0755)
			if mode == "symlink-parent" {
				os.Symlink(outside, filepath.Join(destination, "images"))
			}
			file := map[string]any{"path": "images/a.bin", "size": 3, "checksumSHA256": base64SHA("abc"), "checksumType": "FULL_OBJECT"}
			storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if mode == "checksum" {
					w.Write([]byte("bad"))
				} else if mode == "size" {
					w.Write([]byte("ab"))
				} else {
					w.Write([]byte("abc"))
				}
			}))
			defer storage.Close()
			file["url"] = storage.URL
			files := []map[string]any{file}
			switch mode {
			case "traversal":
				file["path"] = "../escape"
			case "duplicate":
				files = append(files, file)
			case "prefix-conflict":
				files = append(files, map[string]any{"path": "images", "size": 3, "url": storage.URL})
			case "receipt-path":
				file["path"] = ".pai-input-receipt.json"
			case "composite":
				file["checksumType"] = "COMPOSITE"
				file["checksumSHA256"] = base64SHA("composite digest")
			}
			input := map[string]any{"destination": destination, "manifestHash": strings.Repeat("a", 64), "files": files}
			if mode == "broker-alias" {
				delete(input, "destination")
				input["fsxPath"] = destination
				input["index"] = 0
				file["versionId"] = "version-1"
			}
			b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/runtime/inputs" {
					json.NewEncoder(w).Encode(map[string]any{"inputs": []map[string]any{input}})
				} else {
					w.WriteHeader(204)
				}
			}))
			defer b.Close()
			var out, log bytes.Buffer
			r := testRunner(t, b.URL, baseContract, &out, &log)
			r.opts.inputRoot = root
			want := 125
			if mode == "composite" || mode == "broker-alias" {
				want = 0
			}
			if code := r.prepareInputs(context.Background()); code != want {
				t.Fatalf("exit %d want %d: %s", code, want, log.String())
			}
			if want == 125 {
				if _, err := os.Stat(filepath.Join(destination, ".pai-input-receipt.json")); !os.IsNotExist(err) {
					t.Fatal("failed hydration wrote a receipt")
				}
			}
			entries, _ := os.ReadDir(outside)
			if len(entries) != 0 {
				t.Fatal("symlink escaped cache root")
			}
		})
	}
}

func TestInputDestinationsAreScopedToProjectDatasetRoot(t *testing.T) {
	for _, path := range []string{"/etc", "/fsx/checkpoints/x", "/fsx/datasets/projects/other/cache", "/fsx/datasets/projects/mine/../other/cache"} {
		plan := inputPlan{Inputs: []input{{Destination: path, ManifestHash: strings.Repeat("a", 64), Files: []inputFile{{Path: "x", URL: "https://storage/x", Size: 1}}}}}
		if err := validateInputs(&plan, "mine", "/fsx/datasets", "test-secret"); err == nil {
			t.Fatalf("unscoped destination %s", path)
		}
	}
}

func TestInputDownloadConcurrencyIsBounded(t *testing.T) {
	root := t.TempDir()
	var active, peak atomic.Int32
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); n > old; old = peak.Load() {
			if peak.CompareAndSwap(old, n) {
				break
			}
		}
		time.Sleep(25 * time.Millisecond)
		w.Write([]byte("abc"))
	}))
	defer storage.Close()
	files := make([]inputFile, 12)
	for i := range files {
		files[i] = inputFile{Path: strings.Repeat("a", i+1), URL: storage.URL, Size: 3, ChecksumSHA256: base64SHA("abc")}
	}
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/runtime/inputs" {
			json.NewEncoder(w).Encode(inputPlan{Inputs: []input{{Destination: filepath.Join(root, "cache"), ManifestHash: strings.Repeat("a", 64), Files: files}}})
		} else {
			w.WriteHeader(204)
		}
	}))
	defer b.Close()
	var out, log bytes.Buffer
	r := testRunner(t, b.URL, baseContract, &out, &log)
	r.opts.inputRoot = root
	if code := r.prepareInputs(context.Background()); code != 0 {
		t.Fatalf("exit %d: %s", code, log.String())
	}
	if peak.Load() < 2 || peak.Load() > 4 {
		t.Fatalf("download concurrency %d, expected 2..4", peak.Load())
	}
}

func TestInputFencingCancelsDownloadWithoutReceipt(t *testing.T) {
	root := t.TempDir()
	destination := filepath.Join(root, "cache")
	var downloading atomic.Bool
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downloading.Store(true)
		<-r.Context().Done()
	}))
	defer storage.Close()
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/runtime/inputs":
			json.NewEncoder(w).Encode(inputPlan{Inputs: []input{{Destination: destination, ManifestHash: strings.Repeat("a", 64), Files: []inputFile{{Path: "data.bin", URL: storage.URL, Size: 3}}}}})
		case "/runtime/heartbeat":
			if downloading.Load() {
				w.WriteHeader(410)
			} else {
				w.WriteHeader(204)
			}
		default:
			w.WriteHeader(404)
		}
	}))
	defer b.Close()
	var out, log bytes.Buffer
	r := testRunner(t, b.URL, baseContract, &out, &log)
	r.opts.inputRoot = root
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if code := r.prepareInputs(ctx); code != 125 {
		t.Fatalf("fenced hydration exit %d", code)
	}
	if !strings.Contains(log.String(), "fenced") {
		t.Fatalf("fencing not reported: %s", log.String())
	}
	if _, err := os.Stat(filepath.Join(destination, receiptName)); !os.IsNotExist(err) {
		t.Fatal("fenced download wrote success receipt")
	}
	if _, err := os.Stat(filepath.Join(destination, "data.bin")); !os.IsNotExist(err) {
		t.Fatal("partial file renamed after fence")
	}
	entries, _ := os.ReadDir(destination)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".pai-input-tmp-") {
			t.Fatal("download temporary file leaked")
		}
	}
}
