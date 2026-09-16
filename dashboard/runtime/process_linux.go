package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

type processResult struct {
	code int
	err  error
}
type process struct {
	cmd   *exec.Cmd
	done  chan processResult
	grace time.Duration
}

func startProcess(argv []string, stdin io.Reader, stdout, stderr io.Writer, grace time.Duration, resumeJSON string) (*process, error) {
	if len(argv) == 0 || argv[0] == "" {
		return nil, errors.New("missing workload command")
	}
	for _, s := range argv {
		if strings.ContainsRune(s, 0) {
			return nil, errors.New("invalid workload argument")
		}
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	// Bound Wait's stream-copy wait if a descendant inherits an output pipe.
	cmd.WaitDelay = grace
	for _, s := range os.Environ() {
		if !strings.HasPrefix(s, "PAI_RUNTIME_TOKEN=") && !strings.HasPrefix(s, "PAI_RESUME_CHECKPOINTS=") {
			cmd.Env = append(cmd.Env, s)
		}
	}
	cmd.Env = append(cmd.Env, "PAI_RESUME_CHECKPOINTS="+resumeJSON)
	if err := cmd.Start(); err != nil {
		return nil, errors.New("cannot start workload executable")
	}
	p := &process{cmd: cmd, done: make(chan processResult, 1), grace: grace}
	go func() {
		err := cmd.Wait()
		result := processResult{}
		if cmd.ProcessState != nil {
			if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				result.code = 128 + int(status.Signal())
			} else {
				result.code = cmd.ProcessState.ExitCode()
			}
		}
		var exitErr *exec.ExitError
		if err != nil && !errors.As(err, &exitErr) && !errors.Is(err, exec.ErrWaitDelay) {
			result.err = errors.New("workload output or wait failed")
		}
		p.done <- result
	}()
	return p, nil
}

// Also invoked after ordinary exit, to clean up descendants which outlive argv[0].
// The group ID remains the original child PID until every member has exited.
func (p *process) cleanup() {
	pgid := p.cmd.Process.Pid
	if err := syscall.Kill(-pgid, syscall.SIGTERM); err == syscall.ESRCH {
		return
	}
	deadline := time.Now().Add(p.grace)
	for time.Now().Before(deadline) {
		if syscall.Kill(-pgid, 0) == syscall.ESRCH {
			return
		}
		time.Sleep(min(10*time.Millisecond, time.Until(deadline)))
	}
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
}
