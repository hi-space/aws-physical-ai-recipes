package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func TestMultipartCheckpointTransfersResumeRetryAndCommit(t *testing.T) {
	for _, mode := range []string{"success", "lost-part-reply", "expired-part-url", "ambiguous-complete", "fenced-complete", "bad-part-number", "missing-checksum", "oversized-reply", "bad-full-sha"} {
		t.Run(mode, func(t *testing.T) {
			data := bytes.Repeat([]byte("checkpoint-real-bytes-"), (10<<20)/22+1)
			data = append(data, []byte("last-short-part")...)
			partSize := int64(5 << 20)
			partCount := int((int64(len(data)) + partSize - 1) / partSize)
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "model.pt"), data, 0600); err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256(data)
			full := base64.StdEncoding.EncodeToString(sum[:])
			var mu sync.Mutex
			stored := map[int][]byte{}
			puts, plans := map[int]int{}, map[int]int{}
			completeCalls, commits, aborts := 0, 0, 0
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if strings.HasPrefix(request.URL.Path, "/put/") {
					if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
						t.Error("bearer leaked to part endpoint")
					}
					number, _ := strconv.Atoi(strings.TrimPrefix(request.URL.Path, "/put/"))
					puts[number]++
					body, err := io.ReadAll(request.Body)
					if err != nil {
						t.Error(err)
						return
					}
					if mode == "expired-part-url" && number == 2 && puts[number] == 1 {
						w.WriteHeader(403)
						return
					}
					digest := sha256.Sum256(body)
					if request.Header.Get("X-Amz-Checksum-Sha256") != base64.StdEncoding.EncodeToString(digest[:]) {
						t.Error("part SHA256 does not match transmitted bytes")
					}
					start := int64(number-1) * partSize
					end := min(int64(len(data)), start+partSize)
					if !bytes.Equal(body, data[start:end]) || request.ContentLength != int64(len(body)) {
						t.Error("wrong part boundary or contents")
					}
					stored[number] = body
					if mode == "lost-part-reply" && number == 2 && puts[number] == 1 {
						w.WriteHeader(500)
						return
					}
					if mode == "oversized-reply" {
						w.Write(bytes.Repeat([]byte("x"), maxResponseBytes+1))
						return
					}
					w.WriteHeader(200)
					return
				}
				if request.Header.Get("Authorization") != "Bearer test-secret" {
					t.Error("missing scoped bearer")
					w.WriteHeader(401)
					return
				}
				switch request.URL.Path {
				case "/runtime/uploads":
					var publication publication
					if err := json.NewDecoder(request.Body).Decode(&publication); err != nil {
						t.Error(err)
					}
					if publication.ProtocolVersion != 2 || len(publication.SnapshotID) != 32 || len(publication.Files) != 1 ||
						publication.Files[0].ChecksumSHA256 != full || publication.Files[0].Size != int64(len(data)) {
						t.Error("wrong immutable snapshot registration")
					}
					json.NewEncoder(w).Encode(uploadPlan{PublicationID: strings.Repeat("a", 64), State: "PENDING"})
				case "/runtime/uploads/file":
					json.NewEncoder(w).Encode(uploadFileReply{Path: "model.pt", State: "OPEN", Mode: "MULTIPART", PartSize: partSize, PartCount: partCount})
				case "/runtime/uploads/part":
					var part uploadPartRequest
					json.NewDecoder(request.Body).Decode(&part)
					plans[part.Number]++
					if _, found := stored[part.Number]; found {
						json.NewEncoder(w).Encode(uploadPartReply{Number: part.Number, State: "UPLOADED"})
						return
					}
					headers := map[string]string{"x-amz-checksum-sha256": part.ChecksumSHA256}
					if mode == "missing-checksum" {
						headers = nil
					}
					number := part.Number
					if mode == "bad-part-number" {
						number++
					}
					json.NewEncoder(w).Encode(uploadPartReply{Number: number, State: "UPLOAD",
						URL: server.URL + "/put/" + strconv.Itoa(part.Number) + "?generation=" + strconv.Itoa(plans[part.Number]), Headers: headers})
				case "/runtime/uploads/file/complete":
					completeCalls++
					if mode == "fenced-complete" {
						json.NewEncoder(w).Encode(uploadFileReply{State: "ERROR", Status: 410})
						return
					}
					if mode == "bad-full-sha" {
						json.NewEncoder(w).Encode(uploadFileReply{State: "ERROR", Status: 422})
						return
					}
					var joined []byte
					for number := 1; number <= partCount; number++ {
						joined = append(joined, stored[number]...)
					}
					digest := sha256.Sum256(joined)
					if base64.StdEncoding.EncodeToString(digest[:]) != full {
						t.Error("complete object SHA differs from snapshot")
					}
					if mode == "ambiguous-complete" && completeCalls == 1 {
						w.Write([]byte(` {"state":"ERROR","status":503,"error":"ambiguous completion"}`))
						return
					}
					w.Write([]byte(" \n "))
					json.NewEncoder(w).Encode(uploadFileReply{Path: "model.pt", State: "COMPLETE", Mode: "MULTIPART"})
				case "/runtime/uploads/complete":
					commits++
					json.NewEncoder(w).Encode(checkpointReceipt{State: "READY", PublicationID: strings.Repeat("a", 64),
						ManifestURI: "s3://bucket/prefix/manifest.json", ManifestVersionID: "immutable-v1",
						ManifestHash: strings.Repeat("b", 64), VerifiedAt: "2026-09-16T00:00:00Z", ObjectCount: 1, SizeBytes: int64(len(data))})
				case "/runtime/uploads/abort":
					aborts++
					w.Write([]byte(`{"state":"ABORTED","clean":true}`))
				default:
					t.Error("unexpected upload endpoint", request.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			var out, log bytes.Buffer
			runtime := testRunner(t, server.URL, checkpointContract(t, root), &out, &log)
			err := runtime.publish(context.Background(), runtime.contract.Checkpoint[0])
			mu.Lock()
			defer mu.Unlock()
			success := mode == "success" || mode == "lost-part-reply" || mode == "expired-part-url" || mode == "ambiguous-complete"
			if success {
				if err != nil || commits != 1 || aborts != 0 || len(stored) != partCount {
					t.Fatalf("incomplete multipart publish: %v commits=%d aborts=%d", err, commits, aborts)
				}
				if mode == "lost-part-reply" && (puts[2] != 1 || plans[2] != 2) {
					t.Fatal("did not resume the already stored part after lost reply")
				}
				if mode == "expired-part-url" && (puts[2] != 2 || plans[2] != 2) {
					t.Fatal("did not refresh expired part URL")
				}
				if mode == "ambiguous-complete" && completeCalls != 2 {
					t.Fatal("did not reconcile ambiguous completion")
				}
			} else {
				if err == nil || commits != 0 || aborts != 1 {
					t.Fatalf("false multipart success: %v commits=%d aborts=%d", err, commits, aborts)
				}
				if mode == "fenced-complete" && !errors.Is(err, errFenced) {
					t.Fatal("fencing cause was lost")
				}
			}
			if strings.Contains(log.String(), "test-secret") {
				t.Fatal("credential leaked in diagnostics")
			}
		})
	}
}

func TestSectionDigestAndLargeMultipartLayoutDoNotAllocateFileSize(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "sparse")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	offset := int64(6 << 30)
	if err := file.Truncate(offset + 64); err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteAt(bytes.Repeat([]byte{19}, 64), offset); err != nil {
		t.Fatal(err)
	}
	digest, err := sectionDigest(context.Background(), file.Name(), offset, 64)
	expected := sha256.Sum256(bytes.Repeat([]byte{19}, 64))
	if err != nil || digest != base64.StdEncoding.EncodeToString(expected[:]) {
		t.Fatalf("large-file section hashing failed: %s %v", digest, err)
	}
}

func TestNewRuntimeUsesExactLegacyShapeWhenOldBrokerRejectsV2(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "model.pt"), []byte("abc"), 0600)
	registrations, puts, completions := 0, 0, 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/runtime/uploads":
			registrations++
			var payload map[string]json.RawMessage
			json.NewDecoder(request.Body).Decode(&payload)
			if _, exists := payload["protocolVersion"]; exists {
				w.WriteHeader(400) // Old broker's strict request schema.
				return
			}
			if len(payload) != 3 || payload["snapshotId"] != nil {
				t.Error("legacy request contains new fields")
			}
			json.NewEncoder(w).Encode(uploadPlan{Uploads: []upload{{Path: "model.pt", URL: server.URL + "/legacy-put"}}})
		case "/legacy-put":
			puts++
			if request.Header.Get("Authorization") != "" {
				t.Error("bearer leaked")
			}
			body, _ := io.ReadAll(request.Body)
			if string(body) != "abc" {
				t.Error("legacy contents changed")
			}
			w.WriteHeader(200)
		case "/runtime/uploads/complete":
			completions++
			var payload map[string]json.RawMessage
			json.NewDecoder(request.Body).Decode(&payload)
			if len(payload) != 3 {
				t.Error("legacy completion shape changed")
			}
			w.WriteHeader(204)
		default:
			t.Error("unexpected new protocol endpoint")
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	var out, log bytes.Buffer
	r := testRunner(t, server.URL, checkpointContract(t, root), &out, &log)
	if err := r.publish(context.Background(), r.contract.Checkpoint[0]); err != nil {
		t.Fatal(err)
	}
	if registrations != 2 || puts != 1 || completions != 1 {
		t.Fatalf("legacy negotiation failed: %d %d %d", registrations, puts, completions)
	}
}

func TestMultipartPublicationRequiresMatchingReadyReceipt(t *testing.T) {
	for _, field := range []string{"state", "publicationId", "manifestHash", "manifestVersionId", "sizeBytes", "objectCount", "manifestUri"} {
		t.Run(field, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				receipt := map[string]any{"state": "READY", "publicationId": strings.Repeat("a", 64),
					"manifestHash": strings.Repeat("b", 64), "manifestVersionId": "v1",
					"manifestUri": "s3://bucket/manifest.json", "verifiedAt": "2026-09-16T00:00:00Z",
					"objectCount": 1, "sizeBytes": 3}
				delete(receipt, field)
				json.NewEncoder(w).Encode(receipt)
			}))
			defer server.Close()
			var out, log bytes.Buffer
			r := testRunner(t, server.URL, baseContract, &out, &log)
			request := publication{ProtocolVersion: 2, Purpose: "checkpoint", Destination: "s3://bucket/project/",
				Files: []fileManifest{{Path: "model.pt", Size: 3}}}
			if err := r.finishPublication(context.Background(), request, strings.Repeat("a", 64)); err == nil {
				t.Fatal("accepted HTTP 200 without a matching READY receipt")
			}
		})
	}
}
