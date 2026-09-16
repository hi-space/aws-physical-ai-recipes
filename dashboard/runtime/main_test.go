package main

import (
	"bytes"
	"context"
	"debug/elf"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestStaticCLIHandlesSIGTERMAndPublishesFinalCheckpoint(t *testing.T) {
	// Exercises actual CLI parsing, OS signals and child execution in the
	// compiled static executable, rather than calling the runner directly.
	bin := filepath.Join(t.TempDir(), "pai-runtime")
	build := exec.Command("go", "build", "-trimpath", "-o", bin, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOTOOLCHAIN=local", "GOPROXY=off")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v: %s", err, output)
	}
	image, err := elf.Open(bin)
	if err != nil {
		t.Fatal(err)
	}
	for _, prog := range image.Progs {
		if prog.Type == elf.PT_INTERP {
			t.Fatal("executable requires a dynamic interpreter")
		}
	}
	image.Close()

	root := t.TempDir()
	var completed atomic.Int32
	var mu sync.Mutex
	var terminal stateReport
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		if string(data) != "final-data\n" {
			t.Errorf("final checkpoint data: %q", data)
		}
		w.WriteHeader(200)
	}))
	defer storage.Close()
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/runtime/state":
			var state stateReport
			json.NewDecoder(r.Body).Decode(&state)
			mu.Lock()
			terminal = state
			mu.Unlock()
			w.WriteHeader(204)
		case "/runtime/heartbeat":
			w.WriteHeader(204)
		case "/runtime/barrier":
			w.Write([]byte(`{"released":true}`))
		case "/runtime/uploads":
			json.NewEncoder(w).Encode(map[string]any{"uploads": []map[string]string{{"path": "weights.pt", "url": storage.URL}}})
		case "/runtime/uploads/complete":
			completed.Add(1)
			w.WriteHeader(204)
		case "/runtime/inputs":
			w.Write([]byte(`{"inputs":[]}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer b.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "--contract", checkpointContract(t, root), "--", "/bin/sh", "-c",
		`trap 'echo final-data > "$1/weights.pt"; exit 0' TERM; echo live-output; echo live-error >&2; touch "$1/started"; while :; do sleep 1; done`, "sh", root)
	cmd.Env = append(os.Environ(), "PAI_RUNTIME_ENDPOINT="+b.URL, "PAI_RUNTIME_TOKEN=test-secret", "OSMO_TASK_REPLICA_INDEX=0")
	var out, log bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill() })
	eventually(t, func() bool { _, err := os.Stat(filepath.Join(root, "started")); return err == nil })
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	err = cmd.Wait()
	if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 125 {
		t.Fatalf("signal exit: %v; %s", err, log.String())
	}
	if completed.Load() != 1 {
		t.Fatalf("SIGTERM skipped final checkpoint: %s", log.String())
	}
	if !strings.Contains(out.String(), "live-output") || !strings.Contains(log.String(), "live-error") {
		t.Fatal("CLI did not tee streams")
	}
	if strings.Contains(log.String(), "test-secret") {
		t.Fatal("CLI logged bearer")
	}
	mu.Lock()
	if terminal.Phase != "FAILED" || terminal.ExitCode == nil || *terminal.ExitCode != 0 || !strings.HasPrefix(terminal.Message, "runtime-error:") {
		t.Errorf("signal report lost raw exit: %+v", terminal)
	}
	mu.Unlock()
	prepare := exec.CommandContext(ctx, bin, "--prepare-inputs", "--contract", baseContract)
	prepare.Env = cmd.Env
	if output, err := prepare.CombinedOutput(); err != nil {
		t.Fatalf("prepare-inputs CLI failed: %v %s", err, output)
	}
}
