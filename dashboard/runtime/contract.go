package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const maxContractBytes = 256 * 1024

type contract struct {
	WorkflowID        string                     `json:"workflowId"`
	ProjectID         string                     `json:"projectId,omitempty"`
	Namespace         string                     `json:"namespace,omitempty"`
	Epoch             string                     `json:"epoch,omitempty"`
	OutputPath        string                     `json:"outputPath,omitempty"`
	ReplicaIndexEnv   string                     `json:"replicaIndexEnv,omitempty"`
	Task              string                     `json:"task"`
	Attempt           int                        `json:"attempt"`
	Group             *groupContract             `json:"group,omitempty"`
	Checkpoint        []checkpoint               `json:"checkpoint,omitempty"`
	CheckpointRestore bool                       `json:"checkpointRestore,omitempty"`
	ExitActions       map[string]json.RawMessage `json:"exitActions,omitempty"`
	actions           map[int]string
}

type groupContract struct {
	Name                string        `json:"name"`
	Epoch               string        `json:"epoch"`
	Members             []string      `json:"members"`
	Barrier             *bool         `json:"barrier"`
	IgnoreNonleadStatus *bool         `json:"ignoreNonleadStatus"`
	Lead                string        `json:"lead"`
	Participants        []participant `json:"participants,omitempty"`
}

type participant struct {
	ID           string `json:"id"`
	Task         string `json:"task"`
	ReplicaIndex int    `json:"replicaIndex"`
	Resource     string `json:"resource"`
}

type checkpoint struct {
	Path      string `json:"path"`
	URL       string `json:"url"`
	Frequency string `json:"frequency"`
	Regex     string `json:"regex,omitempty"`
	interval  time.Duration
	pattern   *regexp.Regexp
}

var (
	identifier       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$`)
	taskName         = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	digits           = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
	rangePattern     = regexp.MustCompile(`^\s*(\d+)(?:-(\d+))?\s*$`)
	frequencyPattern = regexp.MustCompile(`^([0-9]+)(s|m|h|d)$`)
)

// Reject duplicates, deep nesting, trailing JSON and invalid UTF-8 before typed
// decoding. encoding/json otherwise accepts duplicate keys and replaces UTF-8.
func strictJSON(data []byte, dst any) error {
	if !utf8.Valid(data) {
		return errors.New("invalid JSON encoding")
	}
	d := json.NewDecoder(strings.NewReader(string(data)))
	var value func(int) error
	value = func(depth int) error {
		if depth > 32 {
			return errors.New("JSON nesting exceeds limit")
		}
		tok, err := d.Token()
		if err != nil {
			return errors.New("invalid JSON")
		}
		delim, ok := tok.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				s, ok := key.(string)
				if err != nil || !ok || seen[s] {
					return errors.New("invalid or duplicate JSON key")
				}
				seen[s] = true
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		case '[':
			for d.More() {
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		default:
			return errors.New("invalid JSON delimiter")
		}
		_, err = d.Token()
		return err
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	d = json.NewDecoder(strings.NewReader(string(data)))
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return errors.New("invalid JSON fields or types")
	}
	return nil
}

func parseContract(raw string, replica int) (contract, error) {
	var c contract
	if len(raw) == 0 || len(raw) > maxContractBytes {
		return c, errors.New("contract size outside allowed range")
	}
	if err := strictJSON([]byte(raw), &c); err != nil {
		return c, err
	}
	if !identifier.MatchString(c.WorkflowID) || !taskName.MatchString(c.Task) || len(c.Task) > 40 || c.Attempt < 1 || c.Attempt > 2147483647 || replica < 0 {
		return c, errors.New("invalid workflow, task, attempt or replica")
	}
	if (c.ProjectID != "" && !identifier.MatchString(c.ProjectID)) ||
		(c.Namespace != "" && (!taskName.MatchString(c.Namespace) || len(c.Namespace) > 63)) ||
		(c.Epoch != "" && !identifier.MatchString(c.Epoch)) ||
		(c.OutputPath != "" && !safeAbsolutePath(c.OutputPath)) {
		return c, errors.New("invalid compiler scope metadata")
	}
	switch c.ReplicaIndexEnv {
	case "", "PAI_REPLICA_INDEX", "OSMO_TASK_REPLICA_INDEX", "JOB_COMPLETION_INDEX":
	default:
		return c, errors.New("invalid replica environment selector")
	}
	if g := c.Group; g != nil {
		if !taskName.MatchString(g.Name) || len(g.Name) > 30 || !identifier.MatchString(g.Epoch) || !taskName.MatchString(g.Lead) ||
			g.Barrier == nil || g.IgnoreNonleadStatus == nil || len(g.Members) == 0 || len(g.Members) > 3200 {
			return c, errors.New("invalid group contract")
		}
		seen := map[string]bool{}
		hasLead := false
		for _, member := range g.Members {
			p := strings.Split(member, ":")
			if len(p) != 2 || !taskName.MatchString(p[0]) || len(p[0]) > 40 || !digits.MatchString(p[1]) || seen[member] {
				return c, errors.New("invalid or duplicate group member")
			}
			index, err := strconv.ParseInt(p[1], 10, 32)
			if err != nil || index < 0 {
				return c, errors.New("invalid group replica")
			}
			hasLead = hasLead || p[0] == g.Lead
			seen[member] = true
		}
		if !hasLead || !seen[c.Task+":"+strconv.Itoa(replica)] {
			return c, errors.New("group does not contain leader or current replica")
		}
		if c.Epoch != "" && c.Epoch != g.Epoch {
			return c, errors.New("group epoch does not match attempt epoch")
		}
		if g.Participants != nil {
			if len(g.Participants) != len(g.Members) {
				return c, errors.New("group participants do not match members")
			}
			participants := map[string]bool{}
			for _, p := range g.Participants {
				if p.ReplicaIndex < 0 || p.ID != p.Task+":"+strconv.Itoa(p.ReplicaIndex) || !seen[p.ID] || participants[p.ID] ||
					len(p.Resource) == 0 || len(p.Resource) > 256 || strings.ContainsAny(p.Resource, "\x00\r\n") {
					return c, errors.New("invalid group participant")
				}
				participants[p.ID] = true
			}
		}
	}
	c.actions = map[int]string{}
	for action, rawRange := range c.ExitActions {
		if action != "COMPLETE" && action != "FAIL" && action != "RESCHEDULE" {
			return c, errors.New("unknown exit action")
		}
		var text string
		if json.Unmarshal(rawRange, &text) != nil {
			var number int
			if string(rawRange) == "null" || json.Unmarshal(rawRange, &number) != nil {
				return c, errors.New("invalid exit range")
			}
			text = strconv.Itoa(number)
		}
		for _, part := range strings.Split(text, ",") {
			m := rangePattern.FindStringSubmatch(part)
			if m == nil {
				return c, errors.New("invalid exit range")
			}
			lo, err := strconv.Atoi(m[1])
			if err != nil {
				return c, errors.New("invalid exit range")
			}
			hi := lo
			if m[2] != "" {
				hi, err = strconv.Atoi(m[2])
			}
			if err != nil || lo > hi || hi > 65535 {
				return c, errors.New("invalid exit range")
			}
			for i := lo; i <= hi; i++ {
				if _, ok := c.actions[i]; ok {
					return c, errors.New("overlapping exit actions")
				}
				c.actions[i] = action
			}
		}
	}
	if len(c.Checkpoint) > 64 {
		return c, errors.New("too many checkpoint entries")
	}
	destinations := map[string]bool{}
	for i := range c.Checkpoint {
		cp := &c.Checkpoint[i]
		if !safeAbsolutePath(cp.Path) {
			return c, errors.New("unsafe checkpoint path")
		}
		u, err := url.Parse(cp.URL)
		if err != nil || u.Scheme != "s3" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Port() != "" || strings.ContainsAny(cp.URL, "\r\n\x00") {
			return c, errors.New("invalid checkpoint destination")
		}
		if destinations[cp.URL] {
			return c, errors.New("duplicate checkpoint destination")
		}
		destinations[cp.URL] = true
		m := frequencyPattern.FindStringSubmatch(cp.Frequency)
		if m == nil {
			return c, errors.New("invalid checkpoint frequency")
		}
		n, err := strconv.ParseInt(m[1], 10, 64)
		unit := map[string]time.Duration{"s": time.Second, "m": time.Minute, "h": time.Hour, "d": 24 * time.Hour}[m[2]]
		if err != nil || n <= 0 || n > int64((1<<63-1)/unit) {
			return c, errors.New("invalid checkpoint frequency")
		}
		cp.interval = time.Duration(n) * unit
		if len(cp.Regex) > 4096 {
			return c, errors.New("checkpoint regex exceeds limit")
		}
		if cp.Regex != "" {
			cp.pattern, err = regexp.Compile(cp.Regex)
			if err != nil {
				return c, errors.New("invalid checkpoint regex")
			}
		}
	}
	return c, nil
}

func safeAbsolutePath(p string) bool {
	return len(p) <= 4096 && filepath.IsAbs(p) && filepath.Clean(p) != "/" &&
		filepath.Clean(p) == strings.TrimSuffix(p, "/") && !strings.ContainsAny(p, "\x00\r\n")
}

func validHTTPURL(raw string, base bool) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 16384 || strings.ContainsAny(raw, "\r\n\x00") || u == nil ||
		(u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || u.Opaque != "" ||
		(base && (u.RawQuery != "" || u.ForceQuery)) {
		return nil, errors.New("invalid HTTP endpoint")
	}
	return u, nil
}

func runtimeEnvironment() (string, string, int, error) {
	endpoint, token := os.Getenv("PAI_RUNTIME_ENDPOINT"), os.Getenv("PAI_RUNTIME_TOKEN")
	if _, err := validHTTPURL(endpoint, true); err != nil {
		return "", "", 0, err
	}
	if len(token) == 0 || len(token) > 16384 || strings.ContainsAny(token, " \t\r\n\x00") {
		return "", "", 0, errors.New("missing or invalid runtime bearer")
	}
	for _, r := range token {
		if r < 33 || r > 126 {
			return "", "", 0, errors.New("invalid runtime bearer")
		}
	}
	index := os.Getenv("OSMO_TASK_REPLICA_INDEX")
	if index == "" {
		index = os.Getenv("JOB_COMPLETION_INDEX")
	}
	if index == "" {
		index = os.Getenv("PAI_REPLICA_INDEX")
	}
	if index == "" {
		index = "0"
	}
	if !digits.MatchString(index) {
		return "", "", 0, errors.New("invalid replica index")
	}
	replica, err := strconv.ParseInt(index, 10, 32)
	if err != nil {
		return "", "", 0, errors.New("invalid replica index")
	}
	return strings.TrimRight(endpoint, "/"), token, int(replica), nil
}

func (c contract) nonleader() bool { return c.Group != nil && c.Task != c.Group.Lead }

func (c contract) outcome(raw int) (string, int) {
	action := c.actions[raw]
	if action == "" {
		if raw == 0 {
			action = "COMPLETE"
		} else {
			action = "FAIL"
		}
	}
	switch action {
	case "COMPLETE":
		return action, 0
	case "RESCHEDULE":
		if raw == 0 {
			return action, 75
		}
	case "FAIL":
		if raw == 0 {
			return action, 1
		}
	}
	return action, raw
}

func failure(label string, err error) error {
	// Callers must only supply sanitized errors, never net/url, os/exec errors,
	// response bodies, contract values or argv.
	return fmt.Errorf("%s: %w", label, err)
}
