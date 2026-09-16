package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

type brokerFixture struct {
	mu         sync.Mutex
	states     []stateReport
	released   atomic.Bool
	stopped    atomic.Bool
	fenced     atomic.Bool
	barriers   atomic.Int32
	heartbeats atomic.Int32
	server     *httptest.Server
}

func newFixture(t *testing.T) *brokerFixture {
	t.Helper()
	f := &brokerFixture{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Error("missing broker bearer")
			w.WriteHeader(401)
			return
		}
		if f.fenced.Load() {
			w.WriteHeader(410)
			return
		}
		switch r.URL.Path {
		case "/runtime/state":
			var s stateReport
			if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
				t.Error(err)
			}
			f.mu.Lock()
			f.states = append(f.states, s)
			f.mu.Unlock()
			w.WriteHeader(204)
		case "/runtime/heartbeat":
			f.heartbeats.Add(1)
			w.WriteHeader(204)
		case "/runtime/barrier":
			if r.URL.Query().Get("replica") != "0" {
				t.Error("missing replica query")
			}
			f.barriers.Add(1)
			json.NewEncoder(w).Encode(map[string]bool{"released": f.released.Load(), "stopped": f.stopped.Load()})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func testOptions() options {
	o := defaultOptions()
	o.pollInterval = 10 * time.Millisecond
	o.heartbeatInterval = 15 * time.Millisecond
	o.killGrace = 50 * time.Millisecond
	o.finalTimeout = 2 * time.Second
	o.requestTimeout = 200 * time.Millisecond
	o.retryDelay = 5 * time.Millisecond
	return o
}

func testRunner(t *testing.T, endpoint, raw string, out, log *bytes.Buffer) *runner {
	t.Helper()
	c, err := parseContract(raw, 0)
	if err != nil {
		t.Fatal(err)
	}
	o := testOptions()
	return &runner{contract: c, replica: 0, broker: newBroker(endpoint, "test-secret", o), opts: o, stdout: out, stderr: log}
}

func eventually(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}

func TestRuntimeWaitsForPreparationAndReportsRawExit(t *testing.T) {
	// Removing the preparation gate would create marker before release.
	f := newFixture(t)
	marker := filepath.Join(t.TempDir(), "started")
	var out, log bytes.Buffer
	r := testRunner(t, f.server.URL, baseContract, &out, &log)
	done := make(chan int, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	go func() {
		done <- r.run(ctx, []string{"/bin/sh", "-c", `echo output; echo error >&2; touch "$1"; exit 7`, "sh", marker})
	}()
	eventually(t, func() bool { return f.barriers.Load() >= 3 })
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("command ran before barrier")
	}
	f.released.Store(true)
	if code := <-done; code != 7 {
		t.Fatalf("exit %d; %s", code, log.String())
	}
	if out.String() != "output\n" || !strings.Contains(log.String(), "error\n") {
		t.Fatalf("tee failed: %q %q", out.String(), log.String())
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.states) != 4 || f.states[0].Ready || !f.states[1].Ready || f.states[2].Phase != "RUNNING" {
		t.Fatalf("state order: %+v", f.states)
	}
	last := f.states[len(f.states)-1]
	if last.Phase != "FAILED" || last.ExitCode == nil || *last.ExitCode != 7 || last.Ready {
		t.Fatalf("raw exit lost: %+v", last)
	}
}

func TestRuntimeMapsActionsWithoutErasingObservedFailure(t *testing.T) {
	for _, tc := range []struct {
		actions, task string
		raw, want     int
		ignore        bool
	}{
		{`{"COMPLETE":7}`, "trainer", 7, 0, false},
		{`{"FAIL":0}`, "trainer", 0, 1, false},
		{`{"RESCHEDULE":0}`, "trainer", 0, 75, false},
		{`{}`, "worker", 9, 0, true},
		{`{}`, "trainer", 9, 9, true},
	} {
		t.Run(tc.task+tc.actions+strconv.Itoa(tc.raw), func(t *testing.T) {
			f := newFixture(t)
			f.released.Store(true)
			raw := `{"workflowId":"r","task":"` + tc.task + `","attempt":1,"group":{"name":"g","epoch":"e","members":["trainer:0","worker:0"],"barrier":false,"ignoreNonleadStatus":` + strconv.FormatBool(tc.ignore) + `,"lead":"trainer"},"exitActions":` + tc.actions + `}`
			var out, log bytes.Buffer
			r := testRunner(t, f.server.URL, raw, &out, &log)
			if code := r.run(context.Background(), []string{"/bin/sh", "-c", "exit " + strconv.Itoa(tc.raw)}); code != tc.want {
				t.Fatalf("got %d: %s", code, log.String())
			}
			last := f.states[len(f.states)-1]
			if last.ExitCode == nil || *last.ExitCode != tc.raw {
				t.Fatalf("lost raw code: %+v", last)
			}
			if tc.raw != 0 && last.Phase != "FAILED" {
				t.Fatalf("failure hidden: %+v", last)
			}
		})
	}
}

func TestFencingKillsProcessGroup(t *testing.T) {
	// Killing only the shell would leave its TERM-ignoring grandchild alive.
	f := newFixture(t)
	f.released.Store(true)
	dir := t.TempDir()
	marker := filepath.Join(dir, "pid")
	var out, log bytes.Buffer
	r := testRunner(t, f.server.URL, baseContract, &out, &log)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	done := make(chan int, 1)
	go func() {
		done <- r.run(ctx, []string{"/bin/sh", "-c", `trap '' TERM; sh -c 'trap "" TERM; while :; do sleep 1; done' & echo $! > "$1"; wait`, "sh", marker})
	}()
	var pid int
	eventually(t, func() bool {
		b, err := os.ReadFile(marker)
		if err != nil {
			return false
		}
		pid, _ = strconv.Atoi(strings.TrimSpace(string(b)))
		return pid > 0
	})
	t.Cleanup(func() { syscall.Kill(pid, syscall.SIGKILL) })
	f.fenced.Store(true)
	if code := <-done; code != 125 {
		t.Fatalf("fenced exit %d: %s", code, log.String())
	}
	eventually(t, func() bool {
		b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
		if os.IsNotExist(err) {
			return true
		}
		i := strings.LastIndex(string(b), ") ")
		return i >= 0 && strings.HasPrefix(string(b)[i+2:], "Z")
	})
	if strings.Contains(log.String(), "test-secret") {
		t.Fatal("leaked bearer")
	}
}

func TestLeaderCompletionStopsOnlyNonleaders(t *testing.T) {
	for _, task := range []string{"worker", "trainer"} {
		t.Run(task, func(t *testing.T) {
			f := newFixture(t)
			f.released.Store(true)
			raw := `{"workflowId":"r","task":"` + task + `","attempt":1,"group":{"name":"g","epoch":"e","members":["trainer:0","worker:0"],"barrier":true,"ignoreNonleadStatus":false,"lead":"trainer"}}`
			var out, log bytes.Buffer
			r := testRunner(t, f.server.URL, raw, &out, &log)
			done := make(chan int, 1)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			go func() { done <- r.run(ctx, []string{"/bin/sh", "-c", "sleep 0.25; exit 6"}) }()
			eventually(t, func() bool { return f.barriers.Load() >= 2 })
			f.stopped.Store(true)
			want := 0
			if task == "trainer" {
				want = 6
			}
			if code := <-done; code != want {
				t.Fatalf("got %d want %d: %s", code, want, log.String())
			}
		})
	}
}

func TestChildCannotInheritRuntimeBearer(t *testing.T) {
	f := newFixture(t)
	f.released.Store(true)
	t.Setenv("PAI_RUNTIME_TOKEN", "test-secret")
	var out, log bytes.Buffer
	r := testRunner(t, f.server.URL, baseContract, &out, &log)
	if code := r.run(context.Background(), []string{"/bin/sh", "-c", `test -z "${PAI_RUNTIME_TOKEN+x}"`}); code != 0 {
		t.Fatalf("child inherited bearer: exit %d", code)
	}
}

func TestFenceAtRunningTransitionPreventsCommandAndPublication(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "x.pt"), []byte("checkpoint"), 0600)
	marker := filepath.Join(t.TempDir(), "started")
	var uploads atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/runtime/state":
			var state stateReport
			json.NewDecoder(r.Body).Decode(&state)
			if state.Phase == "RUNNING" {
				w.WriteHeader(410)
			} else {
				w.WriteHeader(204)
			}
		case "/runtime/heartbeat":
			w.WriteHeader(204)
		case "/runtime/barrier":
			w.Write([]byte(`{"released":true}`))
		case "/runtime/uploads":
			uploads.Add(1)
			w.WriteHeader(403)
		default:
			w.WriteHeader(404)
		}
	}))
	defer s.Close()
	var out, log bytes.Buffer
	r := testRunner(t, s.URL, checkpointContract(t, root), &out, &log)
	if code := r.run(context.Background(), []string{"/bin/sh", "-c", `touch "$1"`, "sh", marker}); code != 125 {
		t.Fatalf("fenced exit %d", code)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("fenced command started")
	}
	if uploads.Load() != 0 {
		t.Fatal("attempted publication after fencing")
	}
}

func TestNonleaderStoppedBeforeReleaseDoesNotInventSuccessfulExit(t *testing.T) {
	f := newFixture(t)
	f.stopped.Store(true)
	raw := `{"workflowId":"r","task":"worker","attempt":1,"group":{"name":"g","epoch":"e","members":["trainer:0","worker:0"],"barrier":false,"ignoreNonleadStatus":false,"lead":"trainer"}}`
	var out, log bytes.Buffer
	r := testRunner(t, f.server.URL, raw, &out, &log)
	if code := r.run(context.Background(), []string{"/does-not-exist"}); code != 0 {
		t.Fatalf("stop exit %d: %s", code, log.String())
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	last := f.states[len(f.states)-1]
	if last.Phase != "FAILED" || last.ExitCode != nil || !strings.HasPrefix(last.Message, "group-stopped:") {
		t.Fatalf("invented successful process exit: %+v", last)
	}
}
