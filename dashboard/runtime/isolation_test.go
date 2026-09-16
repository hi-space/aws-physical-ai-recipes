package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func testIsolationGate() isolationGate {
	g := defaultIsolationGate()
	g.timeout = time.Second
	g.probeTimeout = 20 * time.Millisecond
	g.interval = time.Millisecond
	return g
}

func TestIsolationRequiresBothEndpointsBlockedForThreeConsecutiveRounds(t *testing.T) {
	for _, reachableAddress := range []string{"169.254.169.254:80", "169.254.170.23:80"} {
		t.Run(reachableAddress, func(t *testing.T) {
			g := testIsolationGate()
			calls := 0
			g.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
				if network != "tcp4" {
					t.Fatal("isolation must use IPv4 TCP")
				}
				expected := []string{"169.254.169.254:80", "169.254.170.23:80"}[calls%2]
				if address != expected {
					t.Fatalf("unexpected target: %s", address)
				}
				round := calls / 2
				calls++
				if round == 2 && address == reachableAddress {
					client, server := net.Pipe()
					t.Cleanup(func() { server.Close() })
					go func() {
						var data [1]byte
						n, _ := server.Read(data[:])
						if n != 0 {
							t.Error("isolation probe sent application data")
						}
					}()
					return client, nil
				}
				return nil, syscall.ECONNREFUSED
			}
			if err := g.verify(context.Background()); err != nil {
				t.Fatal(err)
			}
			if calls != 12 {
				t.Fatalf("accepted nonconsecutive results: %d calls, want 6 rounds", calls)
			}
		})
	}
}

func TestIsolationDeadlineAndCancellationNeverProveIsolation(t *testing.T) {
	g := testIsolationGate()
	g.timeout = 15 * time.Millisecond
	g.dial = func(context.Context, string, string) (net.Conn, error) {
		client, server := net.Pipe()
		server.Close()
		return client, nil // Successful connect is reachable even if peer closes.
	}
	start := time.Now()
	if err := g.verify(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("reachable targets passed or lost deadline: %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("isolation deadline not bounded")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	g.dial = func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("dialed after cancellation")
		return nil, syscall.ECONNREFUSED
	}
	if err := g.verify(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled check passed: %v", err)
	}
}

func TestIsolationProbeTimeoutsAndLocalDialFailures(t *testing.T) {
	g := testIsolationGate()
	g.probeTimeout = time.Millisecond
	calls := 0
	g.dial = func(ctx context.Context, _, _ string) (net.Conn, error) {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 10*time.Millisecond {
			t.Fatal("probe does not have its own short deadline")
		}
		calls++
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if err := g.verify(context.Background()); err != nil || calls != 6 {
		t.Fatalf("three unreachable rounds failed: %d %v", calls, err)
	}
	g.dial = func(context.Context, string, string) (net.Conn, error) {
		return nil, syscall.EMFILE
	}
	if err := g.verify(context.Background()); err == nil {
		t.Fatal("local file descriptor exhaustion was treated as verified isolation")
	}
}

func TestIsolationCLIBypassesContractAndRejectsChildArguments(t *testing.T) {
	t.Setenv("PAI_RUNTIME_TOKEN", "")
	t.Setenv("PAI_RUNTIME_ENDPOINT", "")
	var calls atomic.Int32
	var output bytes.Buffer
	check := func(context.Context) error { calls.Add(1); return nil }
	if code := runCLI(context.Background(), []string{"--verify-isolation"}, nil, &output, &output, check); code != 0 || calls.Load() != 1 {
		t.Fatalf("isolation requires runtime credentials or did not run: %d %s", code, output.String())
	}
	for _, args := range [][]string{
		{"--verify-isolation", "--", "/bin/true"},
		{"--verify-isolation", "--contract", baseContract},
	} {
		if code := runCLI(context.Background(), args, nil, &output, &output, check); code == 0 {
			t.Fatal("isolation accepted additional command or contract arguments")
		}
	}
	if calls.Load() != 1 {
		t.Fatal("invalid isolation invocation still ran the checker")
	}
	if code := runCLI(context.Background(), []string{"--verify-isolation"}, nil, &output, &output,
		func(context.Context) error { return context.DeadlineExceeded }); code == 0 {
		t.Fatal("failed isolation check returned success")
	}
}
