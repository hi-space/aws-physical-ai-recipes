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
)

func TestExpiredInputURLsRefreshOnlyPinnedIdentity(t *testing.T) {
	for _, mode := range []string{"unchanged", "manifest", "path", "version", "size", "checksum", "checksum-type", "destination", "missing-file", "fenced", "repeated-403"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			destination := filepath.Join(root, "cache")
			var plans, expired, fresh atomic.Int32
			storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "" {
					t.Error("download received scoped bearer")
				}
				if r.URL.Path == "/expired" {
					expired.Add(1)
					w.WriteHeader(403)
					return
				}
				fresh.Add(1)
				if mode == "repeated-403" {
					w.WriteHeader(403)
					return
				}
				w.Write([]byte("abc"))
			}))
			defer storage.Close()
			b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test-secret" {
					t.Error("refresh missing scoped bearer")
				}
				switch r.URL.Path {
				case "/runtime/heartbeat":
					w.WriteHeader(204)
				case "/runtime/inputs":
					n := plans.Add(1)
					file := inputFile{Path: "data.bin", URL: storage.URL + "/expired", Size: 3,
						VersionID: "pinned-v1", ChecksumSHA256: base64SHA("abc"), ChecksumType: "FULL_OBJECT"}
					in := input{Destination: destination, ManifestHash: strings.Repeat("a", 64), Files: []inputFile{file}}
					if n > 1 {
						in.Files[0].URL = storage.URL + "/fresh"
						switch mode {
						case "manifest":
							in.ManifestHash = strings.Repeat("b", 64)
						case "path":
							in.Files[0].Path = "other.bin"
						case "version":
							in.Files[0].VersionID = "new-v2"
						case "size":
							in.Files[0].Size = 4
						case "checksum":
							in.Files[0].ChecksumSHA256 = base64SHA("bad")
						case "checksum-type":
							in.Files[0].ChecksumType = "COMPOSITE"
						case "destination":
							in.Destination = filepath.Join(root, "different-cache")
						case "missing-file":
							in.Files = []inputFile{}
						case "fenced":
							w.WriteHeader(410)
							return
						}
					}
					json.NewEncoder(w).Encode(inputPlan{Inputs: []input{in}})
				default:
					t.Error("unexpected route during refresh")
					w.WriteHeader(404)
				}
			}))
			defer b.Close()
			var out, log bytes.Buffer
			r := testRunner(t, b.URL, baseContract, &out, &log)
			r.opts.inputRoot = root
			code := r.prepareInputs(context.Background())
			if mode == "unchanged" {
				if code != 0 {
					t.Fatalf("expiry refresh failed: %s", log.String())
				}
				data, err := os.ReadFile(filepath.Join(destination, "data.bin"))
				if err != nil || string(data) != "abc" {
					t.Fatalf("refreshed download missing: %q %v", data, err)
				}
				if plans.Load() != 2 || expired.Load() != 1 || fresh.Load() != 1 {
					t.Fatalf("wrong refresh sequence: plans=%d old=%d fresh=%d", plans.Load(), expired.Load(), fresh.Load())
				}
			} else {
				if code != 125 {
					t.Fatalf("unsafe refresh succeeded: %d", code)
				}
				if _, err := os.Stat(filepath.Join(destination, receiptName)); !os.IsNotExist(err) {
					t.Fatal("failed refresh wrote a receipt")
				}
				if mode != "repeated-403" && fresh.Load() != 0 {
					t.Fatal("fetched changed identity before validating refresh")
				}
				if mode == "repeated-403" && (plans.Load() != 3 || expired.Load()+fresh.Load() != 3) {
					t.Fatal("403 refresh exceeded or bypassed the three-attempt bound")
				}
				if mode == "fenced" && !strings.Contains(log.String(), "fenced") {
					t.Fatalf("refresh lost fencing error: %s", log.String())
				}
			}
			if strings.Contains(log.String(), "test-secret") || strings.Contains(log.String(), storage.URL) {
				t.Fatal("refresh logged credentials or signed URL")
			}
		})
	}
}

func TestConcurrentExpiredDownloadsShareOneValidatedRefresh(t *testing.T) {
	root := t.TempDir()
	var plans atomic.Int32
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/expired/") {
			w.WriteHeader(403)
			return
		}
		w.Write([]byte("abc"))
	}))
	defer storage.Close()
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/runtime/inputs" {
			w.WriteHeader(204)
			return
		}
		generation := "expired"
		if plans.Add(1) > 1 {
			generation = "fresh"
		}
		files := make([]inputFile, 12)
		for i := range files {
			path := strings.Repeat("a", i+1)
			files[i] = inputFile{Path: path, URL: storage.URL + "/" + generation + "/" + path,
				Size: 3, VersionID: "v1", ChecksumSHA256: base64SHA("abc")}
		}
		json.NewEncoder(w).Encode(inputPlan{Inputs: []input{{Destination: filepath.Join(root, "cache"),
			ManifestHash: strings.Repeat("a", 64), Files: files}}})
	}))
	defer b.Close()
	var out, log bytes.Buffer
	r := testRunner(t, b.URL, baseContract, &out, &log)
	r.opts.inputRoot = root
	if code := r.prepareInputs(context.Background()); code != 0 {
		t.Fatalf("concurrent refresh failed: %s", log.String())
	}
	if plans.Load() != 2 {
		t.Fatalf("expected initial plan plus shared refresh, got %d requests", plans.Load())
	}
}
