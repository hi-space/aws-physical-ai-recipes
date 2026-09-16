package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"
)

func validHexSHA(value string) bool {
	b, err := hex.DecodeString(value)
	return err == nil && len(b) == 32 && hex.EncodeToString(b) == value
}

type fileReference struct {
	PublicationID string `json:"publicationId"`
	Path          string `json:"path"`
}
type uploadFileReply struct {
	Path      string            `json:"path"`
	Mode      string            `json:"mode"`
	State     string            `json:"state"`
	PartSize  int64             `json:"partSize,omitempty"`
	PartCount int               `json:"partCount,omitempty"`
	URL       string            `json:"url,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	Status    int               `json:"status,omitempty"`
	Error     string            `json:"error,omitempty"`
}
type uploadPartRequest struct {
	fileReference
	Number         int    `json:"number"`
	ChecksumSHA256 string `json:"checksumSHA256"`
}
type uploadPartReply struct {
	State   string            `json:"state"`
	Number  int               `json:"number"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}
type invalidUploadResponse struct{ message string }

func (e *invalidUploadResponse) Error() string { return e.message }

type checkpointReceipt struct {
	State             string `json:"state"`
	PublicationID     string `json:"publicationId"`
	ManifestURI       string `json:"manifestUri"`
	ManifestVersionID string `json:"manifestVersionId"`
	ManifestHash      string `json:"manifestHash"`
	VerifiedAt        string `json:"verifiedAt"`
	ObjectCount       int    `json:"objectCount"`
	SizeBytes         int64  `json:"sizeBytes"`
	Status            int    `json:"status,omitempty"`
	Error             string `json:"error,omitempty"`
}

func (r *runner) finishPublication(ctx context.Context, request publication, id string) error {
	ctx, cancel := context.WithTimeout(ctx, r.opts.publicationTimeout)
	defer cancel()
	for attempt := 0; attempt < 10000; attempt++ {
		if attempt > 0 {
			if err := waitContext(ctx, min(5*time.Second, r.opts.retryDelay*time.Duration(1<<min(attempt, 5)))); err != nil {
				return err
			}
		}
		var receipt checkpointReceipt
		if err := r.broker.requestTimeout(ctx, http.MethodPost, "/runtime/uploads/complete", request,
			&receipt, 200, r.opts.publicationTimeout); err != nil {
			var status *brokerHTTPError
			if errors.As(err, &status) && (status.status == 409 || status.status == 429 || status.status >= 500) {
				continue
			}
			return failure("checkpoint completion rejected", err)
		}
		if receipt.State == "ERROR" {
			if receipt.Status == 410 {
				return errFenced
			}
			if receipt.Status == 409 || receipt.Status == 429 || receipt.Status >= 500 {
				continue
			}
			return fmt.Errorf("checkpoint publication rejected (HTTP %d)", receipt.Status)
		}
		size := int64(0)
		for _, file := range request.Files {
			size += file.Size
		}
		uri, err := url.Parse(receipt.ManifestURI)
		destination, destinationError := url.Parse(request.Destination)
		_, timeError := time.Parse(time.RFC3339, receipt.VerifiedAt)
		if receipt.State != "READY" || receipt.PublicationID != id || !validHexSHA(receipt.ManifestHash) ||
			receipt.ManifestVersionID == "" || receipt.ManifestVersionID == "null" ||
			receipt.ObjectCount != len(request.Files) || receipt.SizeBytes != size || timeError != nil ||
			err != nil || destinationError != nil || uri.Scheme != "s3" || uri.Host != destination.Host ||
			uri.User != nil || uri.RawQuery != "" || uri.Fragment != "" || uri.Path == "" {
			return errors.New("checkpoint publication has no matching immutable READY receipt")
		}
		return nil
	}
	return errors.New("checkpoint publication is not committed")
}

func (r *runner) uploadFile(ctx context.Context, publicationID string, file fileManifest, stage string) error {
	ctx, cancel := context.WithTimeout(ctx, r.opts.publicationTimeout)
	defer cancel()
	reference := fileReference{PublicationID: publicationID, Path: file.Path}
	var plan uploadFileReply
	if err := r.broker.request(ctx, http.MethodPost, "/runtime/uploads/file", reference, &plan, 200); err != nil {
		return err
	}
	if plan.Path != file.Path || (plan.Mode != "SINGLE" && plan.Mode != "MULTIPART") {
		return errors.New("invalid checkpoint file plan identity")
	}
	if plan.State == "COMPLETE" {
		return nil
	}
	switch plan.Mode {
	case "SINGLE":
		if file.Size > maxFileBytes || plan.State != "OPEN" {
			return errors.New("invalid single checkpoint upload plan")
		}
		var last error
		for attempt := 0; attempt < 3; attempt++ {
			if attempt > 0 {
				if err := waitContext(ctx, r.opts.retryDelay); err != nil {
					return err
				}
				if err := r.broker.request(ctx, http.MethodPost, "/runtime/uploads/file", reference, &plan, 200); err != nil {
					return err
				}
				if plan.Path != file.Path || plan.Mode != "SINGLE" {
					return errors.New("checkpoint file identity changed")
				}
				if plan.State == "COMPLETE" {
					return nil
				}
			}
			u := upload{Path: file.Path, URL: plan.URL, Headers: plan.Headers}
			if plan.State != "OPEN" {
				return errors.New("single checkpoint upload is no longer open")
			}
			if err := r.validateTransfer(u, file.Size, stage); err != nil {
				return err
			}
			last = r.broker.putSection(ctx, u, stage, 0, file.Size)
			var invalid *invalidUploadResponse
			if errors.As(last, &invalid) {
				return last
			}
			if last == nil {
				break
			}
		}
		if last != nil {
			return last
		}
	case "MULTIPART":
		if plan.PartSize < minMultipartPartBytes || plan.PartSize > maxFileBytes || plan.PartCount < 1 ||
			plan.PartCount > maxMultipartParts || file.Size <= 0 || plan.PartCount != int((file.Size+plan.PartSize-1)/plan.PartSize) ||
			(plan.State != "OPEN" && plan.State != "COMPLETING") || plan.URL != "" || len(plan.Headers) != 0 {
			return errors.New("invalid multipart checkpoint layout")
		}
		if plan.State == "OPEN" {
			for number := 1; number <= plan.PartCount; number++ {
				offset := int64(number-1) * plan.PartSize
				size := min(plan.PartSize, file.Size-offset)
				digest, err := sectionDigest(ctx, stage, offset, size)
				if err != nil {
					return err
				}
				request := uploadPartRequest{fileReference: reference, Number: number, ChecksumSHA256: digest}
				var last error
				for attempt := 0; attempt < 3; attempt++ {
					if attempt > 0 {
						if err := waitContext(ctx, r.opts.retryDelay); err != nil {
							return err
						}
					}
					var part uploadPartReply
					if err := r.broker.request(ctx, http.MethodPost, "/runtime/uploads/part", request, &part, 200); err != nil {
						return err
					}
					if part.Number != number {
						return errors.New("checkpoint part number changed")
					}
					if part.State == "UPLOADED" {
						if part.URL != "" || len(part.Headers) != 0 {
							return errors.New("completed part returned unexpected credentials")
						}
						last = nil
						break
					}
					if part.State != "UPLOAD" {
						return errors.New("invalid checkpoint part state")
					}
					u := upload{Path: file.Path, URL: part.URL, Headers: part.Headers}
					if err := r.validateTransfer(u, size, stage); err != nil {
						return err
					}
					found := false
					for key, value := range u.Headers {
						if http.CanonicalHeaderKey(key) == "X-Amz-Checksum-Sha256" && value == digest {
							found = true
						}
					}
					if !found {
						return errors.New("checkpoint part signature is not bound to SHA256")
					}
					last = r.broker.putSection(ctx, u, stage, offset, size)
					var invalid *invalidUploadResponse
					if errors.As(last, &invalid) {
						return last
					}
					if last == nil {
						break
					}
				}
				if last != nil {
					return last
				}
			}
		}
	}
	// The response may include periodic JSON whitespace while the broker streams
	// an immutable S3 version through native SHA256. Do not use the 10s control
	// deadline or treat an initial HTTP 200/keepalive as publication success.
	for attempt := 0; attempt < 10000; attempt++ {
		if attempt > 0 {
			if err := waitContext(ctx, min(5*time.Second, r.opts.retryDelay*time.Duration(1<<min(attempt, 5)))); err != nil {
				return err
			}
		}
		var complete uploadFileReply
		if err := r.broker.requestTimeout(ctx, http.MethodPost, "/runtime/uploads/file/complete",
			reference, &complete, 200, r.opts.publicationTimeout); err != nil {
			var status *brokerHTTPError
			if errors.As(err, &status) && (status.status == 409 || status.status == 429 || status.status >= 500) {
				continue
			}
			return err
		}
		if complete.State == "ERROR" {
			if complete.Status == 410 {
				return errFenced
			}
			if complete.Status == 409 || complete.Status == 429 || complete.Status >= 500 {
				continue
			}
			return fmt.Errorf("checkpoint file verification rejected (HTTP %d)", complete.Status)
		}
		if complete.State != "COMPLETE" || complete.Path != file.Path || complete.Mode != plan.Mode {
			return errors.New("checkpoint file did not finish checksum verification")
		}
		return nil
	}
	return errors.New("checkpoint file verification is incomplete")
}

func (r *runner) validateTransfer(u upload, size int64, stage string) error {
	return validatePlan(uploadPlan{Uploads: []upload{u}}, &snapshot{
		files: []fileManifest{{Path: u.Path, Size: size}}, staged: map[string]string{u.Path: stage},
	}, r.broker.token)
}

func sectionDigest(ctx context.Context, path string, offset, size int64) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", errors.New("cannot open checkpoint part")
	}
	defer file.Close()
	hash := sha256.New()
	n, err := io.CopyBuffer(hash, contextReader{ctx: ctx, reader: io.NewSectionReader(file, offset, size)}, make([]byte, 128*1024))
	if err != nil || n != size {
		return "", errors.New("cannot checksum complete checkpoint part")
	}
	return base64.StdEncoding.EncodeToString(hash.Sum(nil)), nil
}

func (b *broker) putSection(ctx context.Context, u upload, path string, offset, size int64) error {
	file, err := os.Open(path)
	if err != nil {
		return errors.New("cannot reopen checkpoint snapshot")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || offset < 0 || size < 0 || offset > info.Size() || size > info.Size()-offset {
		return errors.New("checkpoint part is outside snapshot")
	}
	callCtx, cancel := context.WithTimeout(ctx, b.opts.putTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(callCtx, http.MethodPut, u.URL, io.NewSectionReader(file, offset, size))
	if err != nil {
		return errors.New("cannot create checkpoint part request")
	}
	request.ContentLength = size
	for key, value := range u.Headers {
		request.Header.Set(key, value)
	}
	response, err := b.http.Do(request)
	if err != nil {
		return errors.New("checkpoint part transport or timeout failure")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if len(body) > maxResponseBytes {
		return &invalidUploadResponse{"checkpoint part response exceeds size limit"}
	}
	if err != nil {
		return errors.New("cannot read checkpoint part response")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("checkpoint part PUT returned HTTP %d", response.StatusCode)
	}
	return nil
}
