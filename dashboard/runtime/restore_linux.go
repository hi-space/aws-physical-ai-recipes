package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

type checkpointSource struct {
	WorkflowID string `json:"workflowId"`
	Task       string `json:"task"`
	Attempt    int    `json:"attempt"`
	Epoch      string `json:"epoch"`
}
type restoredCheckpoint struct {
	Index         int              `json:"index"`
	Path          string           `json:"path"`
	Destination   string           `json:"destination"`
	PublicationID string           `json:"publicationId"`
	ManifestHash  string           `json:"manifestHash"`
	Source        checkpointSource `json:"source"`
	Files         []inputFile      `json:"files"`
}
type restorePlan struct {
	Checkpoints []restoredCheckpoint `json:"checkpoints"`
	NextCursor  string               `json:"nextCursor,omitempty"`
}
type restoreReceipt struct {
	Version       int              `json:"version"`
	Path          string           `json:"path"`
	PublicationID string           `json:"publicationId"`
	ManifestHash  string           `json:"manifestHash"`
	Source        checkpointSource `json:"source"`
	Target        checkpointSource `json:"target"`
}

var hexDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (r *runner) fetchRestores(ctx context.Context) (restorePlan, error) {
	plan, err := r.fetchRestorePages(ctx)
	if err != nil {
		return plan, err
	}
	if !safeAbsolutePath(r.contract.OutputPath) || plan.Checkpoints == nil || len(plan.Checkpoints) > len(r.contract.Checkpoint) {
		return plan, errors.New("invalid checkpoint restore plan or output root")
	}
	seen := map[int]bool{}
	paths := map[string]bool{}
	for _, cp := range plan.Checkpoints {
		if cp.Index < 0 || cp.Index >= len(r.contract.Checkpoint) || seen[cp.Index] ||
			cp.Path != r.contract.Checkpoint[cp.Index].Path || paths[cp.Path] ||
			!hexDigest.MatchString(cp.ManifestHash) || !hexDigest.MatchString(cp.PublicationID) {
			return plan, errors.New("checkpoint restore identity does not match contract")
		}
		seen[cp.Index] = true
		paths[cp.Path] = true
		expected := filepath.Join(r.contract.OutputPath, ".pai-resume", "replica-"+strconv.Itoa(r.replica), "checkpoint-"+strconv.Itoa(cp.Index), cp.ManifestHash)
		if cp.Destination != expected {
			return plan, errors.New("checkpoint restore destination escapes current attempt")
		}
		source := cp.Source
		if !identifier.MatchString(source.WorkflowID) || source.Task != r.contract.Task ||
			source.Attempt < 1 || source.Attempt > 2147483647 || !identifier.MatchString(source.Epoch) ||
			(source.WorkflowID == r.contract.WorkflowID && (source.Attempt >= r.contract.Attempt || source.Epoch == r.contract.Epoch)) ||
			(source.WorkflowID != r.contract.WorkflowID && !r.contract.CheckpointRestore) {
			return plan, errors.New("checkpoint source is not an authorized previous attempt")
		}
		if len(cp.Files) == 0 {
			return plan, errors.New("committed checkpoint has no files")
		}
		for _, file := range cp.Files {
			if file.Size > maxCheckpointFileBytes || file.VersionID == "" || file.VersionID == "null" ||
				file.ChecksumType != "FULL_OBJECT" || !validDigest(file.ChecksumSHA256) {
				return plan, errors.New("checkpoint restore requires bounded files with pinned full-object checksums")
			}
			for _, part := range strings.Split(file.Path, "/") {
				if reservedRuntimeName(part) {
					return plan, errors.New("checkpoint contains reserved runtime metadata")
				}
			}
		}
		// Reuse complete per-file URL/path/size/duplicate validation while the
		// exact destination above supplies the stricter private restore boundary.
		check := inputPlan{Inputs: []input{{Destination: cp.Destination, ManifestHash: cp.ManifestHash, Files: cp.Files}}}
		if err := validateInputs(&check, "", r.contract.OutputPath, r.broker.token); err != nil {
			return plan, err
		}
	}
	return plan, nil
}

func restoreInput(cp restoredCheckpoint) input {
	index := cp.Index
	return input{Index: &index, Destination: cp.Destination, ManifestHash: cp.ManifestHash, Files: cp.Files}
}
func sameRestoreIdentity(a, b restoredCheckpoint) bool {
	return a.Index == b.Index && a.Path == b.Path && a.Destination == b.Destination &&
		a.PublicationID == b.PublicationID && a.ManifestHash == b.ManifestHash && a.Source == b.Source
}

func (r *runner) restoreCheckpoints(ctx context.Context) (map[string]string, error) {
	mapping := map[string]string{}
	plan, err := r.fetchRestores(ctx)
	if err != nil {
		return nil, err
	}
	for _, cp := range plan.Checkpoints {
		in := restoreInput(cp)
		urls := newInputURLs(r, in)
		urls.load = func(ctx context.Context) ([]input, error) {
			fresh, err := r.fetchRestores(ctx)
			if err != nil {
				return nil, err
			}
			if len(fresh.Checkpoints) != len(plan.Checkpoints) {
				return nil, errors.New("checkpoint publication set changed during URL refresh")
			}
			for _, candidate := range fresh.Checkpoints {
				if candidate.Index != cp.Index {
					continue
				}
				if !sameRestoreIdentity(cp, candidate) {
					return nil, errors.New("committed checkpoint identity changed during URL refresh")
				}
				return []input{restoreInput(candidate)}, nil
			}
			return nil, errors.New("pinned checkpoint missing during URL refresh")
		}
		if err := r.hydrateWithURLs(ctx, in, urls); err != nil {
			return nil, err
		}
		if err := r.writeRestoreReceipt(ctx, cp); err != nil {
			return nil, err
		}
		mapping[cp.Path] = cp.Destination
	}
	return mapping, nil
}

func (r *runner) writeRestoreReceipt(ctx context.Context, cp restoredCheckpoint) error {
	dir, err := openCheckpointRoot(cp.Destination)
	if err != nil {
		return err
	}
	defer dir.Close()
	receipt := restoreReceipt{Version: 1, Path: cp.Path, PublicationID: cp.PublicationID, ManifestHash: cp.ManifestHash, Source: cp.Source,
		Target: checkpointSource{WorkflowID: r.contract.WorkflowID, Task: r.contract.Task, Attempt: r.contract.Attempt, Epoch: r.contract.Epoch}}
	data, err := json.Marshal(receipt)
	if err != nil {
		return errors.New("cannot encode checkpoint restore receipt")
	}
	file, name, err := temporaryFileAt(dir, ".pai-restore-receipt-")
	if err != nil {
		return errors.New("cannot create checkpoint restore receipt")
	}
	defer syscall.Unlinkat(int(dir.Fd()), name)
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	file.Close()
	if writeErr != nil || syncErr != nil {
		return errors.New("cannot persist checkpoint restore receipt")
	}
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	if err := syscall.Renameat(int(dir.Fd()), name, int(dir.Fd()), ".pai-restore-receipt.json"); err != nil {
		return errors.New("cannot publish checkpoint restore receipt")
	}
	if err := dir.Sync(); err != nil {
		return errors.New("cannot sync checkpoint restore receipt")
	}
	return nil
}

// Restore files are process-lifetime input, not new experiment output. Remove
// only this replica's private contents before terminal reporting can trigger an
// artifact export of the output root. Go Root keeps recursive removal confined.
func (r *runner) cleanupRestores() error {
	output, err := openCheckpointRoot(r.contract.OutputPath)
	if err != nil {
		return errors.New("cannot open output root for restore cleanup")
	}
	defer output.Close()
	flags := syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
	parentFD, err := syscall.Openat(int(output.Fd()), ".pai-resume", flags, 0)
	if err == syscall.ENOENT {
		return nil
	}
	if err != nil {
		return errors.New("private restore directory changed before cleanup")
	}
	parent := os.NewFile(uintptr(parentFD), "restore-cleanup-parent")
	defer parent.Close()
	replicaName := "replica-" + strconv.Itoa(r.replica)
	fd, err := syscall.Openat(parentFD, replicaName, flags, 0)
	if err == syscall.ENOENT {
		return nil
	}
	if err != nil {
		return errors.New("private replica restore directory changed before cleanup")
	}
	verified := os.NewFile(uintptr(fd), "restore-cleanup-root")
	defer verified.Close()
	expected, err := verified.Stat()
	if err != nil {
		return errors.New("cannot verify private restore directory")
	}
	root, err := os.OpenRoot(filepath.Join(r.contract.OutputPath, ".pai-resume", replicaName))
	if err != nil {
		return errors.New("cannot anchor private restore cleanup")
	}
	defer root.Close()
	actual, err := root.Stat(".")
	if err != nil || !os.SameFile(expected, actual) {
		return errors.New("private restore directory identity changed")
	}
	for {
		entries, err := verified.ReadDir(128)
		if err != nil && err != io.EOF {
			return errors.New("cannot enumerate private restore cleanup")
		}
		for _, entry := range entries {
			if err := root.RemoveAll(entry.Name()); err != nil {
				return errors.New("cannot remove private restored files")
			}
		}
		if err == io.EOF {
			break
		}
	}
	return nil
}
