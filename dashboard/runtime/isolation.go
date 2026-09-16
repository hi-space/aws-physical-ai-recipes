package main

import (
	"context"
	"errors"
	"net"
	"syscall"
	"time"
)

type isolationGate struct {
	dial                            func(context.Context, string, string) (net.Conn, error)
	timeout, probeTimeout, interval time.Duration
}

func defaultIsolationGate() isolationGate {
	return isolationGate{
		dial:         (&net.Dialer{}).DialContext,
		timeout:      120 * time.Second,
		probeTimeout: 500 * time.Millisecond,
		interval:     time.Second,
	}
}

func (g isolationGate) verify(parent context.Context) error {
	ctx, cancel := context.WithTimeout(parent, g.timeout)
	defer cancel()
	consecutive := 0
	for {
		if ctx.Err() != nil {
			return context.Cause(ctx)
		}
		blocked := true
		for _, address := range []string{"169.254.169.254:80", "169.254.170.23:80"} {
			denied, err := g.probe(ctx, address)
			if err != nil {
				return err
			}
			blocked = blocked && denied
		}
		if ctx.Err() != nil {
			return context.Cause(ctx)
		}
		if blocked {
			consecutive++
		} else {
			consecutive = 0
		}
		if consecutive == 3 {
			return nil
		}
		if err := waitContext(ctx, g.interval); err != nil {
			return err
		}
	}
}

func (g isolationGate) probe(ctx context.Context, address string) (bool, error) {
	probe, cancel := context.WithTimeout(ctx, g.probeTimeout)
	defer cancel()
	conn, err := g.dial(probe, "tcp4", address)
	if conn != nil {
		// TCP connect/close only: never write an HTTP request or read a response.
		conn.Close()
	}
	if ctx.Err() != nil {
		return false, context.Cause(ctx)
	}
	if conn != nil && err == nil {
		return false, nil
	}
	if err == nil {
		return false, errors.New("isolation dialer returned no connection or error")
	}
	// Network denial, lack of a route, and a timed-out connection meet the
	// connectivity criterion. Local resource/programming failures do not.
	if errors.Is(err, context.DeadlineExceeded) {
		return true, nil
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true, nil
	}
	for _, denied := range []error{syscall.ECONNREFUSED, syscall.EHOSTUNREACH, syscall.ENETUNREACH,
		syscall.EACCES, syscall.EPERM, syscall.ETIMEDOUT, syscall.ENETDOWN, syscall.EHOSTDOWN} {
		if errors.Is(err, denied) {
			return true, nil
		}
	}
	return false, errors.New("isolation connectivity probe failed locally")
}
