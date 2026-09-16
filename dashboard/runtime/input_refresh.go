package main

import (
	"context"
	"errors"
	"sync"
)

// One refresh per input is shared by all download workers. The original
// manifest remains immutable; only independently validated URLs are replaced.
type inputURLs struct {
	mu     sync.Mutex
	runner *runner
	pinned input
	files  map[string]inputFile
	load   func(context.Context) ([]input, error)
}

func newInputURLs(r *runner, in input) *inputURLs {
	urls := &inputURLs{runner: r, pinned: in, files: make(map[string]inputFile, len(in.Files))}
	for _, file := range in.Files {
		urls.files[file.Path] = file
	}
	urls.load = func(ctx context.Context) ([]input, error) {
		plan, err := r.fetchInputPlan(ctx)
		if err != nil {
			return nil, err
		}
		if err := validateInputs(&plan, r.contract.ProjectID, r.opts.inputRoot, r.broker.token); err != nil {
			return nil, err
		}
		return plan.Inputs, nil
	}
	return urls
}

func (u *inputURLs) current(file inputFile) inputFile {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.files[file.Path]
}

func sameInputIdentity(a, b inputFile) bool {
	return a.Path == b.Path && a.VersionID == b.VersionID && a.Size == b.Size &&
		a.ChecksumSHA256 == b.ChecksumSHA256 && a.ChecksumType == b.ChecksumType
}

func sameInputIndex(a, b *int) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

func (u *inputURLs) refresh(ctx context.Context, failed inputFile) (string, error) {
	// A concurrent worker may already have replaced the failing generation.
	// Holding this lock across the bounded request prevents refresh stampedes.
	u.mu.Lock()
	defer u.mu.Unlock()
	if ctx.Err() != nil {
		return "", context.Cause(ctx)
	}
	if current := u.files[failed.Path]; current.URL != failed.URL {
		return current.URL, nil
	}
	for _, file := range u.pinned.Files {
		if file.VersionID == "" || file.VersionID == "null" {
			return "", errors.New("input URL refresh requires pinned object version IDs")
		}
	}
	inputs, err := u.load(ctx)
	if err != nil {
		return "", failure("input URL refresh failed", err)
	}
	for _, candidate := range inputs {
		if candidate.Destination != u.pinned.Destination {
			continue
		}
		if candidate.ManifestHash != u.pinned.ManifestHash || !sameInputIndex(candidate.Index, u.pinned.Index) ||
			len(candidate.Files) != len(u.pinned.Files) {
			return "", errors.New("input URL refresh changed pinned manifest identity")
		}
		replacement := make(map[string]inputFile, len(candidate.Files))
		for _, file := range candidate.Files {
			original, ok := u.files[file.Path]
			if !ok || !sameInputIdentity(original, file) {
				return "", errors.New("input URL refresh changed pinned file identity")
			}
			replacement[file.Path] = file
		}
		if ctx.Err() != nil {
			return "", context.Cause(ctx)
		}
		u.files = replacement
		return replacement[failed.Path].URL, nil
	}
	return "", errors.New("input URL refresh omitted the pinned cache destination")
}
