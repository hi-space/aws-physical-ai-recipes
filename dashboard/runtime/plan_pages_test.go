package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestInputPagesMergePinnedGroupsAndRejectChangedIdentity(t *testing.T) {
	for _, mode := range []string{"valid", "changed-manifest", "repeated-cursor", "empty-page", "too-many-files"} {
		t.Run(mode, func(t *testing.T) {
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				requests++
				if request.URL.Query().Get("pageSize") != "64" {
					t.Error("pagination not negotiated")
				}
				index := 0
				group := input{Index: &index, Destination: "/fsx/datasets/projects/p/data", ManifestHash: strings.Repeat("a", 64), Files: []inputFile{}}
				count := 64
				if requests == 2 {
					count = 1
				}
				if mode == "too-many-files" {
					count = 1025
				}
				if mode == "empty-page" {
					count = 0
				}
				for i := 0; i < count; i++ {
					group.Files = append(group.Files, inputFile{Path: strconv.Itoa((requests-1)*64 + i)})
				}
				plan := inputPlan{Inputs: []input{group}}
				if requests == 1 || mode == "repeated-cursor" {
					plan.NextCursor = "signed.cursor"
				}
				if requests == 2 && mode == "changed-manifest" {
					plan.Inputs[0].ManifestHash = strings.Repeat("b", 64)
				}
				json.NewEncoder(w).Encode(plan)
			}))
			defer server.Close()
			var out, log bytes.Buffer
			r := testRunner(t, server.URL, baseContract, &out, &log)
			plan, err := r.fetchInputPlan(context.Background())
			if mode == "valid" {
				if err != nil || len(plan.Inputs) != 1 || len(plan.Inputs[0].Files) != 65 || requests != 2 {
					t.Fatalf("lost input page: %+v %v", plan, err)
				}
			} else if err == nil {
				t.Fatal("unsafe input pagination accepted")
			}
		})
	}
}

func TestRestorePagesCannotSwitchPublication(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requests++
		cp := restoredCheckpoint{Index: 0, PublicationID: strings.Repeat("a", 64), Files: []inputFile{{Path: "model.pt"}}}
		plan := restorePlan{Checkpoints: []restoredCheckpoint{cp}, NextCursor: "signed.cursor"}
		if requests == 2 {
			plan.Checkpoints[0].PublicationID = strings.Repeat("b", 64)
			plan.NextCursor = ""
		}
		json.NewEncoder(w).Encode(plan)
	}))
	defer server.Close()
	var out, log bytes.Buffer
	r := testRunner(t, server.URL, baseContract, &out, &log)
	if _, err := r.fetchRestorePages(context.Background()); err == nil {
		t.Fatal("restore publication changed between pages")
	}
}

func TestCheckpointTimeoutConfigurationIsBounded(t *testing.T) {
	for _, key := range []string{"PAI_RUNTIME_CHECKPOINT_TIMEOUT_SECONDS", "PAI_RUNTIME_FINAL_CHECKPOINT_TIMEOUT_SECONDS"} {
		for _, value := range []string{"", "0", "01", "-1", "21601", "unbounded"} {
			t.Run(key+value, func(t *testing.T) {
				t.Setenv(key, value)
				if _, err := checkpointOptionsFromEnvironment(defaultOptions()); err == nil {
					t.Fatal("invalid deadline accepted")
				}
			})
		}
	}
}
