package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func pagePath(base, cursor string) string {
	separator := "?"
	if strings.Contains(base, "?") {
		separator = "&"
	}
	path := base + separator + "pageSize=" + strconv.Itoa(planPageFiles)
	if cursor != "" {
		path += "&cursor=" + url.QueryEscape(cursor)
	}
	return path
}
func nextPage(cursor, token string, count int, seen map[string]bool) error {
	if len(cursor) > 1024 || count == 0 || seen[cursor] || strings.Contains(cursor, token) {
		return errors.New("invalid or repeated runtime plan cursor")
	}
	for _, ch := range cursor {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '_' || ch == '.') {
			return errors.New("invalid runtime plan cursor characters")
		}
	}
	seen[cursor] = true
	return nil
}

func (r *runner) fetchInputPlan(ctx context.Context) (inputPlan, error) {
	result := inputPlan{Inputs: []input{}}
	groups := map[string]int{}
	seen := map[string]bool{}
	cursor, total := "", 0
	for page := 0; page <= maxPlanFiles/planPageFiles; page++ {
		var next inputPlan
		if err := r.broker.request(ctx, http.MethodGet, pagePath("/runtime/inputs", cursor), nil, &next, 200); err != nil {
			return result, err
		}
		if next.Inputs == nil {
			return result, errors.New("missing runtime input page")
		}
		count := 0
		pageGroups := map[string]bool{}
		for _, group := range next.Inputs {
			count += len(group.Files)
			total += len(group.Files)
			if total > maxPlanFiles {
				return result, errors.New("input plan exceeds aggregate file limit")
			}
			key := group.Destination
			if key == "" {
				key = group.FSXPath
			}
			if group.Index != nil {
				key = strconv.Itoa(*group.Index)
			}
			if pageGroups[key] {
				return result, errors.New("duplicate input group within page")
			}
			pageGroups[key] = true
			if index, found := groups[key]; found {
				old := &result.Inputs[index]
				if old.Destination != group.Destination || old.FSXPath != group.FSXPath || old.ManifestHash != group.ManifestHash ||
					!sameInputIndex(old.Index, group.Index) {
					return result, errors.New("input identity changed between pages")
				}
				old.Files = append(old.Files, group.Files...)
			} else {
				if len(result.Inputs) >= 64 {
					return result, errors.New("input plan exceeds group limit")
				}
				groups[key] = len(result.Inputs)
				result.Inputs = append(result.Inputs, group)
			}
		}
		if next.NextCursor == "" {
			return result, nil
		}
		if err := nextPage(next.NextCursor, r.broker.token, count, seen); err != nil {
			return result, err
		}
		cursor = next.NextCursor
	}
	return result, errors.New("input plan exceeds page limit")
}

func (r *runner) fetchRestorePages(ctx context.Context) (restorePlan, error) {
	result := restorePlan{Checkpoints: []restoredCheckpoint{}}
	groups := map[int]int{}
	seen := map[string]bool{}
	cursor, total := "", 0
	for page := 0; page <= maxPlanFiles/planPageFiles; page++ {
		var next restorePlan
		path := pagePath("/runtime/checkpoints?replica="+strconv.Itoa(r.replica), cursor)
		if err := r.broker.request(ctx, http.MethodGet, path, nil, &next, 200); err != nil {
			return result, err
		}
		if next.Checkpoints == nil {
			return result, errors.New("missing checkpoint restore page")
		}
		count := 0
		pageGroups := map[int]bool{}
		for _, group := range next.Checkpoints {
			count += len(group.Files)
			total += len(group.Files)
			if total > maxPlanFiles {
				return result, errors.New("restore plan exceeds aggregate file limit")
			}
			if pageGroups[group.Index] {
				return result, errors.New("duplicate restore group within page")
			}
			pageGroups[group.Index] = true
			if index, found := groups[group.Index]; found {
				old := &result.Checkpoints[index]
				if !sameRestoreIdentity(*old, group) {
					return result, errors.New("checkpoint identity changed between pages")
				}
				old.Files = append(old.Files, group.Files...)
			} else {
				if len(result.Checkpoints) >= 64 {
					return result, errors.New("restore plan exceeds group limit")
				}
				groups[group.Index] = len(result.Checkpoints)
				result.Checkpoints = append(result.Checkpoints, group)
			}
		}
		if next.NextCursor == "" {
			return result, nil
		}
		if err := nextPage(next.NextCursor, r.broker.token, count, seen); err != nil {
			return result, err
		}
		cursor = next.NextCursor
	}
	return result, errors.New("checkpoint restore plan exceeds page limit")
}
