package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

var (
	errLeaderStopped = errors.New("group leader completed")
	errExternalStop  = errors.New("runtime received termination")
)

// Child stderr and runtime diagnostics can be written concurrently.
type lockedWriter struct {
	mu     sync.Mutex
	writer io.Writer
}

func (w *lockedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.writer.Write(p)
}

type runner struct {
	contract       contract
	replica        int
	broker         *broker
	opts           options
	stdin          io.Reader
	stdout, stderr io.Writer
}

func (r *runner) log(err error) { fmt.Fprintf(r.stderr, "pai-runtime: %s\n", err) }

func (r *runner) run(parent context.Context, argv []string) int {
	r.stderr = &lockedWriter{writer: r.stderr}
	defer r.broker.http.CloseIdleConnections()
	// The lease stays alive through final checkpoints even after SIGTERM.
	session, cancelSession := context.WithCancelCause(context.Background())
	defer cancelSession(context.Canceled)
	execution, cancelExecution := context.WithCancelCause(session)
	defer cancelExecution(context.Canceled)
	unlink := context.AfterFunc(parent, func() { cancelExecution(errExternalStop) })
	defer unlink()
	if parent.Err() != nil {
		cancelExecution(errExternalStop)
	}
	var monitors sync.WaitGroup
	defer monitors.Wait()
	// Defers run LIFO: cancel before joining the monitor goroutines.
	defer cancelSession(context.Canceled)
	failSession := func(err error) { cancelSession(err) }
	s := stateReport{Phase: "INITIALIZING", Replica: r.replica}
	var issue error
	resumePaths := map[string]string{}
	issue = r.broker.state(execution, s)
	if issue == nil {
		issue = r.broker.heartbeat(execution)
	}
	if issue == nil {
		monitors.Add(1)
		go func() {
			defer monitors.Done()
			for waitContext(session, r.opts.heartbeatInterval) == nil {
				if err := r.broker.heartbeat(session); err != nil {
					failSession(err)
					return
				}
			}
		}()
		if len(r.contract.Checkpoint) > 0 && (r.contract.CheckpointRestore || r.contract.Attempt > 1) {
			restore, cancelRestore := context.WithTimeout(execution, r.opts.publicationTimeout)
			resumePaths, issue = r.restoreCheckpoints(restore)
			cancelRestore()
			if issue != nil {
				issue = failure("checkpoint restore failed", issue)
			}
			if issue == nil {
				if len(resumePaths) > 0 {
					s.Message = fmt.Sprintf("restored %d committed checkpoints", len(resumePaths))
				} else {
					s.Message = "no committed checkpoint available; cold start"
				}
				fmt.Fprintln(r.stderr, "pai-runtime:", s.Message)
			}
		}
		if issue == nil {
			s.Ready = true
			issue = r.broker.state(execution, s)
		}
	}
	if issue == nil {
		for {
			var barrier barrierReply
			barrier, issue = r.broker.barrier(execution, r.replica)
			if issue != nil {
				break
			}
			if barrier.Stopped && r.contract.nonleader() {
				issue = errLeaderStopped
				break
			}
			if *barrier.Released {
				break
			}
			if issue = waitContext(execution, r.opts.pollInterval); issue != nil {
				break
			}
		}
	}
	if errors.Is(issue, errFenced) {
		failSession(issue)
	}
	var result *processResult
	if issue == nil {
		issue = r.broker.state(execution, stateReport{Phase: "RUNNING", Ready: true, Replica: r.replica, Message: s.Message})
	}
	if errors.Is(issue, errFenced) {
		failSession(issue)
	}
	var files *fileService
	if issue == nil && r.contract.OutputPath != "" {
		files, issue = startFileService(execution, r.contract.OutputPath, r.opts.files, failSession)
		if files != nil {
			defer files.Close()
		}
	}
	var p *process
	if issue == nil && execution.Err() != nil {
		issue = context.Cause(execution)
	}
	if issue == nil {
		resumeJSON, _ := json.Marshal(resumePaths)
		p, issue = startProcess(argv, r.stdin, r.stdout, r.stderr, r.opts.killGrace, string(resumeJSON))
	}
	if p != nil {
		if r.contract.Group != nil {
			monitors.Add(1)
			go func() {
				defer monitors.Done()
				for waitContext(execution, r.opts.pollInterval) == nil {
					barrier, err := r.broker.barrier(execution, r.replica)
					if err != nil {
						if execution.Err() == nil {
							failSession(err)
						}
						return
					}
					if barrier.Stopped && r.contract.nonleader() {
						cancelExecution(errLeaderStopped)
						return
					}
				}
			}()
		}
		periodic, stopPeriodic := context.WithCancel(execution)
		var checkpoints sync.WaitGroup
		checkpoints.Add(1)
		go func() { defer checkpoints.Done(); r.periodicCheckpoints(periodic, failSession) }()
		select {
		case observed := <-p.done:
			result = &observed
		case <-execution.Done():
			issue = context.Cause(execution)
		}
		// Cancel in-flight periodic work before final snapshot or cleanup.
		stopPeriodic()
		cancelExecution(context.Canceled)
		if files != nil {
			files.Close()
		}
		p.cleanup()
		if result == nil {
			observed := <-p.done
			result = &observed
		}
		checkpoints.Wait()
		if issue == nil && result.err != nil {
			issue = result.err
		}
	}
	if files != nil {
		files.Close()
	}
	if session.Err() != nil {
		issue = context.Cause(session)
	}
	// Do not let action normalization mask lost leases or failed publication.
	finalCtx, finish := context.WithTimeout(session, r.opts.finalTimeout)
	defer finish()
	if session.Err() == nil && result != nil {
		for _, cp := range r.contract.Checkpoint {
			if err := r.publish(finalCtx, cp); err != nil {
				issue = failure("final checkpoint failed", err)
				if errors.Is(err, errFenced) {
					failSession(err)
				}
				break
			}
		}
	}
	if len(resumePaths) > 0 {
		if err := r.cleanupRestores(); err != nil {
			r.log(err)
			if issue == nil {
				issue = failure("checkpoint restore cleanup failed", err)
			}
		}
	}
	terminal := stateReport{Phase: "SUCCEEDED", Replica: r.replica}
	action, containerCode := "COMPLETE", 0
	if result != nil {
		terminal.ExitCode = &result.code
		action, containerCode = r.contract.outcome(result.code)
		if result.code != 0 {
			terminal.Phase = "FAILED"
		}
	}
	stopped := errors.Is(issue, errLeaderStopped)
	if stopped {
		containerCode = 0
		terminal.Message = "group-stopped: leader completed; observed exit preserved"
		if result == nil {
			terminal.Phase = "FAILED"
		}
	} else if issue != nil {
		containerCode = 125
		terminal.Phase = "FAILED"
		terminal.Message = "runtime-error: " + issue.Error()
		r.log(issue)
	} else {
		terminal.Message = "action=" + action
		if r.contract.nonleader() && *r.contract.Group.IgnoreNonleadStatus && containerCode != 0 {
			containerCode = 0
			terminal.Message += "; ignored nonleader status; observed exit preserved"
		}
	}
	// A failure report gets a fresh bounded control deadline if the session is
	// fenced or final publication consumed its deadline. It cannot publish data.
	reportCtx := finalCtx
	var reportCancel context.CancelFunc
	if finalCtx.Err() != nil {
		reportCtx, reportCancel = context.WithTimeout(context.Background(), r.opts.requestTimeout)
		defer reportCancel()
	}
	if err := r.broker.state(reportCtx, terminal); err != nil {
		r.log(failure("terminal state report failed", err))
		return 125
	}
	return containerCode
}

func (r *runner) periodicCheckpoints(ctx context.Context, fence func(error)) {
	if len(r.contract.Checkpoint) == 0 {
		return
	}
	next := make([]time.Time, len(r.contract.Checkpoint))
	for i, cp := range r.contract.Checkpoint {
		next[i] = time.Now().Add(cp.interval)
	}
	for {
		soon := next[0]
		for _, at := range next {
			if at.Before(soon) {
				soon = at
			}
		}
		if waitContext(ctx, max(0, time.Until(soon))) != nil {
			return
		}
		for i, cp := range r.contract.Checkpoint {
			if time.Now().Before(next[i]) {
				continue
			}
			publication, cancel := context.WithTimeout(ctx, r.opts.publicationTimeout)
			err := r.publish(publication, cp)
			cancel()
			next[i] = time.Now().Add(cp.interval)
			if errors.Is(err, errFenced) {
				fence(err)
				return
			}
			if err != nil && ctx.Err() == nil {
				r.log(failure("periodic checkpoint failed", err))
			}
		}
	}
}
