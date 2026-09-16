package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestBrokerRetriesBoundedlyAndHonorsCancellation(t *testing.T) {
	for _, status := range []int{409, 429, 503, 403, 410} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(status)
				w.Write([]byte("sensitive test-secret response"))
			}))
			defer s.Close()
			b := newBroker(s.URL, "test-secret", testOptions())
			defer b.http.CloseIdleConnections()
			err := b.heartbeat(context.Background())
			want := int32(1)
			if status == 409 || status == 429 || status == 503 {
				want = 3
			}
			if err == nil || calls.Load() != want {
				t.Fatalf("calls=%d error=%v", calls.Load(), err)
			}
			if strings.Contains(err.Error(), "test-secret") {
				t.Fatal("response body leaked")
			}
			if status == 410 && !errors.Is(err, errFenced) {
				t.Fatal("lost fencing error")
			}
		})
	}
	var calls atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		io.Copy(io.Discard, r.Body)
		<-r.Context().Done()
	}))
	defer s.Close()
	b := newBroker(s.URL, "test-secret", testOptions())
	defer b.http.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := b.heartbeat(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cancellation lost: %v", err)
	}
	if time.Since(start) > time.Second || calls.Load() != 1 {
		t.Fatal("deadline did not bound request")
	}
}

func TestBrokerRejectsMalformedBarriersAndNeverFollowsRedirects(t *testing.T) {
	for _, body := range []string{`{}`, `null`, `{"released":"true"}`, `{"released":true,"released":false}`, `{"released":true} {}`, strings.Repeat("x", 2*1024*1024+1)} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }))
		b := newBroker(s.URL, "test-secret", testOptions())
		if _, err := b.barrier(context.Background(), 0); err == nil {
			t.Errorf("accepted invalid barrier %.50s", body)
		}
		b.http.CloseIdleConnections()
		s.Close()
	}
	var calls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(204) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer redirect.Close()
	b := newBroker(redirect.URL, "test-secret", testOptions())
	defer b.http.CloseIdleConnections()
	if err := b.heartbeat(context.Background()); err == nil || calls.Load() != 0 {
		t.Fatal("redirect followed with scoped authorization")
	}
}

func TestFencingResponseDoesNotWaitForBody(t *testing.T) {
	release := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(410)
		w.(http.Flusher).Flush()
		<-release
	}))
	defer s.Close()
	defer close(release)
	o := testOptions()
	o.requestTimeout = time.Second
	b := newBroker(s.URL, "test-secret", o)
	defer b.http.CloseIdleConnections()
	start := time.Now()
	if err := b.heartbeat(context.Background()); !errors.Is(err, errFenced) {
		t.Fatalf("not fenced: %v", err)
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Fatal("fencing blocked on response body")
	}
}
