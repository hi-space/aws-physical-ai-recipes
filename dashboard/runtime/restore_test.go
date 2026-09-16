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

func restoreContract(t *testing.T, root string) string {
	t.Helper()
	data, _ := json.Marshal(map[string]any{"workflowId": "run", "task": "train", "projectId": "p", "attempt": 2,
		"epoch": "epoch-2", "outputPath": root, "checkpointRestore": true,
		"checkpoint": []map[string]string{{"path": root, "url": "s3://artifacts/projects/p/checkpoint", "frequency": "1h"}}})
	return string(data)
}
func restoreFixture(root, url string) restorePlan {
	return restorePlan{Checkpoints: []restoredCheckpoint{{
		Index: 0, Path: root, Destination: filepath.Join(root, ".pai-resume", "replica-0", "checkpoint-0", strings.Repeat("a", 64)),
		ManifestHash: strings.Repeat("a", 64), PublicationID: strings.Repeat("b", 64),
		Source: checkpointSource{WorkflowID: "run", Task: "train", Attempt: 1, Epoch: "epoch-1"},
		Files:  []inputFile{{Path: "final/model.bin", URL: url, Size: 16, ChecksumSHA256: base64SHA("checkpoint bytes"), ChecksumType: "FULL_OBJECT", VersionID: "object-v1"}},
	}}}
}

func TestRestoredChildProcess(t *testing.T) {
	if os.Getenv("PAI_TEST_RESTORED_CHILD") != "1" {
		return
	}
	var mapping map[string]string
	if json.Unmarshal([]byte(os.Getenv("PAI_RESUME_CHECKPOINTS")), &mapping) != nil {
		os.Exit(21)
	}
	root := os.Getenv("PAI_TEST_OUTPUT")
	if len(mapping) != 1 || mapping[root] == "" {
		os.Exit(22)
	}
	data, err := os.ReadFile(filepath.Join(mapping[root], "final/model.bin"))
	if err != nil || string(data) != "checkpoint bytes" {
		os.Exit(23)
	}
	if _, err := os.Stat(filepath.Join(mapping[root], ".pai-restore-receipt.json")); err != nil {
		os.Exit(24)
	}
	if os.WriteFile(filepath.Join(root, "after.bin"), data, 0600) != nil {
		os.Exit(25)
	}
	os.Exit(0)
}

func TestCheckpointRestoresBeforeReadyBarrierAndChildWithAuthoritativeEnvironment(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PAI_TEST_RESTORED_CHILD", "1")
	t.Setenv("PAI_TEST_OUTPUT", root)
	t.Setenv("PAI_RESUME_CHECKPOINTS", `{"fake":"/etc"}`)
	var server *httptest.Server
	var barrier atomic.Bool
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/object" {
			w.Write([]byte("checkpoint bytes"))
			return
		}
		if req.URL.Path == "/put" {
			w.WriteHeader(200)
			return
		}
		if req.Header.Get("Authorization") != "Bearer test-secret" {
			t.Error("wrong current capability")
		}
		plan := restoreFixture(root, server.URL+"/object")
		switch req.URL.Path {
		case "/runtime/checkpoints":
			if req.URL.Query().Get("replica") != "0" {
				t.Error("missing restore replica")
			}
			json.NewEncoder(w).Encode(plan)
		case "/runtime/heartbeat":
			w.WriteHeader(204)
		case "/runtime/state":
			var state stateReport
			json.NewDecoder(req.Body).Decode(&state)
			if state.Phase == "INITIALIZING" && state.Ready {
				if _, err := os.Stat(filepath.Join(plan.Checkpoints[0].Destination, ".pai-restore-receipt.json")); err != nil {
					t.Error("ready before restore receipt")
				}
			}
			if state.ExitCode != nil {
				if _, err := os.Stat(filepath.Join(plan.Checkpoints[0].Destination, "final/model.bin")); !os.IsNotExist(err) {
					t.Error("private restored bytes survived into terminal artifact publication")
				}
			}
			w.WriteHeader(204)
		case "/runtime/barrier":
			if data, err := os.ReadFile(filepath.Join(plan.Checkpoints[0].Destination, "final/model.bin")); err != nil || string(data) != "checkpoint bytes" {
				t.Error("barrier before restored data")
			}
			barrier.Store(true)
			w.Write([]byte(`{"released":true}`))
		case "/runtime/uploads":
			var request publication
			json.NewDecoder(req.Body).Decode(&request)
			if len(request.Files) != 1 || request.Files[0].Path != "after.bin" {
				t.Error("new checkpoint included private restored data")
			}
			json.NewEncoder(w).Encode(uploadPlan{Uploads: []upload{{Path: "after.bin", URL: server.URL + "/put"}}})
		case "/runtime/uploads/complete":
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	var out, log bytes.Buffer
	r := testRunner(t, server.URL, restoreContract(t, root), &out, &log)
	if code := r.run(context.Background(), []string{os.Args[0], "-test.run=^TestRestoredChildProcess$"}); code != 0 {
		t.Fatalf("restore exit %d: %s", code, log.String())
	}
	if !barrier.Load() {
		t.Fatal("barrier was bypassed")
	}
	if data, err := os.ReadFile(filepath.Join(root, "after.bin")); err != nil || string(data) != "checkpoint bytes" {
		t.Fatal("restore cleanup removed new user output")
	}
}

func TestRestoreCleanupNeverFollowsAReplacedPrivateRoot(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	os.WriteFile(filepath.Join(outside, "valuable"), []byte("keep"), 0600)
	os.Symlink(outside, filepath.Join(root, ".pai-resume"))
	r := &runner{contract: contract{OutputPath: root}}
	if err := r.cleanupRestores(); err == nil {
		t.Fatal("cleanup followed a replaced private directory")
	}
	if data, err := os.ReadFile(filepath.Join(outside, "valuable")); err != nil || string(data) != "keep" {
		t.Fatal("cleanup escaped current output")
	}
}

func TestCheckpointRestoreRejectsChangedOrUnsafePinnedPlans(t *testing.T) {
	for _, mode := range []string{"destination", "path", "source-attempt", "source-task", "checksum-type", "missing-version", "duplicate", "corrupt-bytes"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			var fetched atomic.Int32
			object := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fetched.Add(1); w.Write([]byte("corrupt-data-now")) }))
			defer object.Close()
			plan := restoreFixture(root, object.URL)
			cp := &plan.Checkpoints[0]
			switch mode {
			case "destination":
				cp.Destination = filepath.Join(t.TempDir(), "outside")
			case "path":
				cp.Path = "/other"
			case "source-attempt":
				cp.Source.Attempt = 2
			case "source-task":
				cp.Source.Task = "another"
			case "checksum-type":
				cp.Files[0].ChecksumType = "COMPOSITE"
			case "missing-version":
				cp.Files[0].VersionID = ""
			case "duplicate":
				plan.Checkpoints = append(plan.Checkpoints, *cp)
			}
			b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(plan) }))
			defer b.Close()
			var out, log bytes.Buffer
			r := testRunner(t, b.URL, restoreContract(t, root), &out, &log)
			if _, err := r.restoreCheckpoints(context.Background()); err == nil {
				t.Fatal("unsafe checkpoint restore succeeded")
			}
			if mode != "corrupt-bytes" && fetched.Load() != 0 {
				t.Fatal("downloaded before validating restore identity")
			}
			if _, err := os.Stat(filepath.Join(cp.Destination, ".pai-restore-receipt.json")); !os.IsNotExist(err) {
				t.Fatal("failed restore published receipt")
			}
		})
	}
}

func TestCheckpointRestoreRefreshesOnlyTheSameCommittedPublication(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(map[bool]string{false: "same", true: "changed"}[changed], func(t *testing.T) {
			root := t.TempDir()
			object := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/old" {
					w.WriteHeader(403)
				} else {
					w.Write([]byte("checkpoint bytes"))
				}
			}))
			defer object.Close()
			var plans atomic.Int32
			b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/runtime/heartbeat" {
					w.WriteHeader(204)
					return
				}
				plan := restoreFixture(root, object.URL+"/old")
				if plans.Add(1) > 1 {
					plan.Checkpoints[0].Files[0].URL = object.URL + "/new"
					if changed {
						plan.Checkpoints[0].PublicationID = strings.Repeat("c", 64)
					}
				}
				json.NewEncoder(w).Encode(plan)
			}))
			defer b.Close()
			var out, log bytes.Buffer
			r := testRunner(t, b.URL, restoreContract(t, root), &out, &log)
			mapping, err := r.restoreCheckpoints(context.Background())
			if changed && err == nil {
				t.Fatal("changed checkpoint publication accepted on URL refresh")
			}
			if !changed && (err != nil || mapping[root] == "") {
				t.Fatalf("valid refresh failed: %v", err)
			}
		})
	}
}

func TestFencingDuringCheckpointRestoreNeverLaunchesWorkload(t *testing.T) {
	root := t.TempDir()
	var downloading atomic.Bool
	object := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downloading.Store(true)
		<-r.Context().Done()
	}))
	defer object.Close()
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if downloading.Load() {
			w.WriteHeader(410)
			return
		}
		switch r.URL.Path {
		case "/runtime/state", "/runtime/heartbeat":
			w.WriteHeader(204)
		case "/runtime/checkpoints":
			json.NewEncoder(w).Encode(restoreFixture(root, object.URL))
		case "/runtime/barrier":
			t.Error("barrier called before restore completed")
			w.WriteHeader(500)
		default:
			t.Error("unexpected publication during failed restore")
			w.WriteHeader(500)
		}
	}))
	defer broker.Close()
	var out, log bytes.Buffer
	r := testRunner(t, broker.URL, restoreContract(t, root), &out, &log)
	if code := r.run(context.Background(), []string{"/bin/sh", "-c", `touch "$1/started"`, "sh", root}); code != 125 {
		t.Fatalf("fenced restore exit %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "started")); !os.IsNotExist(err) {
		t.Fatal("workload started after restore fencing")
	}
	if !strings.Contains(log.String(), "fenced") {
		t.Fatalf("fencing not reported: %s", log.String())
	}
}
