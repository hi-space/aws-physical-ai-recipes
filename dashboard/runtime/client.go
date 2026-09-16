package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxResponseBytes = 2 * 1024 * 1024

var errFenced = errors.New("runtime epoch fenced")

type options struct {
	requestTimeout, retryDelay, pollInterval, heartbeatInterval time.Duration
	killGrace, finalTimeout, publicationTimeout, putTimeout     time.Duration
	inputRoot                                                   string
	files                                                       fileOptions
}

func defaultOptions() options {
	return options{requestTimeout: 10 * time.Second, retryDelay: 250 * time.Millisecond,
		pollInterval: time.Second, heartbeatInterval: 5 * time.Second,
		killGrace: 5 * time.Second, finalTimeout: 30 * time.Second,
		publicationTimeout: 30 * time.Minute, putTimeout: 5 * time.Minute, inputRoot: "/fsx/datasets", files: defaultFileOptions()}
}

type stateReport struct {
	Phase    string `json:"phase"`
	Ready    bool   `json:"ready"`
	Replica  int    `json:"replica"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Message  string `json:"message,omitempty"`
}

type barrierReply struct {
	Released *bool `json:"released"`
	Stopped  bool  `json:"stopped,omitempty"`
}

type broker struct {
	endpoint, token string
	http            *http.Client
	opts            options
}

func newBroker(endpoint, token string, o options) *broker {
	tr := &http.Transport{
		Proxy:               nil,
		DialContext:         (&net.Dialer{Timeout: o.requestTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout: o.requestTimeout, ResponseHeaderTimeout: o.requestTimeout,
		MaxIdleConns: 8, MaxIdleConnsPerHost: 4, IdleConnTimeout: 30 * time.Second,
		ForceAttemptHTTP2: true,
	}
	return &broker{endpoint: strings.TrimRight(endpoint, "/"), token: token, opts: o,
		http: &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func waitContext(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-t.C:
		return nil
	}
}

func (b *broker) request(ctx context.Context, method, path string, payload any, reply any, exactStatus int) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return errors.New("cannot encode broker request")
	}
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return context.Cause(ctx)
		}
		if attempt > 0 {
			if err := waitContext(ctx, b.opts.retryDelay*time.Duration(1<<(attempt-1))); err != nil {
				return err
			}
		}
		callCtx, cancel := context.WithTimeout(ctx, b.opts.requestTimeout)
		var body io.Reader
		if method != http.MethodGet {
			body = bytes.NewReader(data)
		}
		req, err := http.NewRequestWithContext(callCtx, method, b.endpoint+path, body)
		if err != nil {
			cancel()
			return errors.New("cannot create broker request")
		}
		req.Header.Set("Authorization", "Bearer "+b.token)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		res, err := b.http.Do(req)
		if err != nil {
			cancel()
			last = errors.New("broker transport or timeout failure")
			continue
		}
		status := res.StatusCode
		if status == http.StatusGone {
			res.Body.Close()
			cancel()
			return errFenced
		}
		raw, readErr := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
		res.Body.Close()
		cancel()
		if len(raw) > maxResponseBytes {
			return errors.New("broker response exceeds size limit")
		}
		if readErr != nil {
			last = errors.New("cannot read broker response")
			continue
		}
		if status < 200 || status >= 300 || (exactStatus != 0 && status != exactStatus) {
			last = fmt.Errorf("broker returned HTTP %d", status)
			if status == 409 || status == 429 || status >= 500 {
				continue
			}
			return last
		}
		if reply != nil {
			if err := strictJSON(raw, reply); err != nil {
				return errors.New("invalid broker JSON response")
			}
		}
		return nil
	}
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	return last
}

func (b *broker) state(ctx context.Context, s stateReport) error {
	return b.request(ctx, http.MethodPost, "/runtime/state", s, nil, 0)
}

func (b *broker) heartbeat(ctx context.Context) error {
	return b.request(ctx, http.MethodPost, "/runtime/heartbeat", struct{}{}, nil, 204)
}

func (b *broker) barrier(ctx context.Context, replica int) (barrierReply, error) {
	var reply barrierReply
	err := b.request(ctx, http.MethodGet, "/runtime/barrier?replica="+strconv.Itoa(replica), nil, &reply, 200)
	if err == nil && reply.Released == nil {
		err = errors.New("barrier response missing released flag")
	}
	return reply, err
}
