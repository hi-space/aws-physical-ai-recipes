package main

import (
	"strings"
	"testing"
)

const baseContract = `{"workflowId":"run-123","task":"trainer","attempt":1}`

func TestContractRejectsMalformedAndUnsafeInput(t *testing.T) {
	// Catches permissive JSON decoding, missing scope, unsafe paths and ambiguous ranges.
	for _, raw := range []string{
		`{}`, `null`, baseContract + `{}`,
		`{"workflowId":"x","workflowId":"y","task":"trainer","attempt":1}`,
		`{"workflowId":"x","task":"trainer","attempt":1,"extra":true}`,
		`{"workflowId":"x","task":"trainer","attempt":0}`,
		`{"workflowId":"x","task":"trainer","attempt":1,"exitActions":{"COMPLETE":"0-5","FAIL":3}}`,
		`{"workflowId":"x","task":"trainer","attempt":1,"checkpoint":[{"path":"/tmp/../etc","url":"s3://bucket/a","frequency":"1s"}]}`,
		`{"workflowId":"x","task":"trainer","attempt":1,"checkpoint":[{"path":"/tmp/a","url":"https://bucket/a","frequency":"1s"}]}`,
		`{"workflowId":"x","task":"trainer","attempt":1,"checkpoint":[{"path":"/tmp/a","url":"s3://bucket/a","frequency":"0s"}]}`,
		`{"workflowId":"x","task":"trainer","attempt":1,"checkpoint":[{"path":"/tmp/a","url":"s3://bucket/a","frequency":"1s","regex":"["}]}`,
		strings.Repeat(" ", 256*1024+1),
	} {
		if _, err := parseContract(raw, 0); err == nil {
			t.Errorf("accepted malformed contract %.160s", raw)
		}
	}
}

func TestContractExitActionsAndGroupMembership(t *testing.T) {
	raw := `{"workflowId":"r","task":"trainer","attempt":2,"group":{"name":"g","epoch":"e","members":["trainer:0","worker:0"],"barrier":true,"ignoreNonleadStatus":true,"lead":"trainer"},"exitActions":{"COMPLETE":"0,10-12","FAIL":9,"RESCHEDULE":"75,100-101"}}`
	c, err := parseContract(raw, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		raw, exit int
		action    string
	}{
		{0, 0, "COMPLETE"}, {10, 0, "COMPLETE"}, {9, 9, "FAIL"},
		{75, 75, "RESCHEDULE"}, {42, 42, "FAIL"},
	} {
		action, exit := c.outcome(tc.raw)
		if action != tc.action || exit != tc.exit {
			t.Errorf("exit %d: got %s/%d", tc.raw, action, exit)
		}
	}
	if _, err := parseContract(raw, 1); err == nil {
		t.Fatal("accepted replica outside group membership")
	}
	for _, replacement := range []string{`"members":["trainer:0","trainer:0"]`, `"members":["worker:0"]`} {
		if _, err := parseContract(strings.Replace(raw, `"members":["trainer:0","worker:0"]`, replacement, 1), 0); err == nil {
			t.Fatal("accepted invalid group members")
		}
	}
}

func TestEnvironmentValidation(t *testing.T) {
	t.Setenv("PAI_RUNTIME_ENDPOINT", "http://broker:8080/private")
	t.Setenv("PAI_RUNTIME_TOKEN", "scoped-secret")
	t.Setenv("OSMO_TASK_REPLICA_INDEX", "")
	t.Setenv("JOB_COMPLETION_INDEX", "3")
	_, _, replica, err := runtimeEnvironment()
	if err != nil || replica != 3 {
		t.Fatalf("fallback index: %d %v", replica, err)
	}
	t.Setenv("OSMO_TASK_REPLICA_INDEX", "2")
	_, _, replica, err = runtimeEnvironment()
	if err != nil || replica != 2 {
		t.Fatalf("OSMO index: %d %v", replica, err)
	}
	t.Setenv("OSMO_TASK_REPLICA_INDEX", "-1")
	if _, _, _, err := runtimeEnvironment(); err == nil {
		t.Fatal("accepted negative replica")
	}
	t.Setenv("OSMO_TASK_REPLICA_INDEX", "0")
	for _, endpoint := range []string{"", "file:///tmp/a", "http://user:pass@broker", "http://broker?x=1", "http://broker/#x"} {
		t.Setenv("PAI_RUNTIME_ENDPOINT", endpoint)
		if _, _, _, err := runtimeEnvironment(); err == nil {
			t.Fatal("accepted unsafe endpoint")
		}
	}
	t.Setenv("PAI_RUNTIME_ENDPOINT", "http://broker")
	t.Setenv("PAI_RUNTIME_TOKEN", "")
	if _, _, _, err := runtimeEnvironment(); err == nil {
		t.Fatal("accepted missing token")
	}
}

func TestAcceptsCurrentCompilerMetadata(t *testing.T) {
	raw := `{"workflowId":"run-1","projectId":"project-1","namespace":"pai-project-1","task":"trainer","attempt":1,"epoch":"epoch-1","outputPath":"/fsx/checkpoints/projects/project-1/run-1","replicaIndexEnv":"PAI_REPLICA_INDEX","group":{"name":"g","epoch":"epoch-1","members":["trainer:0"],"participants":[{"id":"trainer:0","task":"trainer","replicaIndex":0,"resource":"gpu"}],"barrier":true,"ignoreNonleadStatus":true,"lead":"trainer"}}`
	if _, err := parseContract(raw, 0); err != nil {
		t.Fatalf("current compiler rejected: %v", err)
	}
	for _, bad := range []string{
		strings.Replace(raw, `"replicaIndex":0`, `"replicaIndex":1`, 1),
		strings.Replace(raw, `"projectId":"project-1"`, `"projectId":"../project-1"`, 1),
		strings.Replace(raw, `"replicaIndexEnv":"PAI_REPLICA_INDEX"`, `"replicaIndexEnv":"HOME"`, 1),
		strings.Replace(raw, `"epoch":"epoch-1"`, `"epoch":"other-epoch"`, 1),
	} {
		if _, err := parseContract(bad, 0); err == nil {
			t.Fatal("unsafe compiler metadata accepted")
		}
	}
}
