package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	code := runCLI(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr, defaultIsolationGate().verify)
	stop()
	os.Exit(code)
}

func runCLI(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer, verifyIsolation func(context.Context) error) int {
	if len(args) == 1 && args[0] == "--verify-isolation" {
		if err := verifyIsolation(ctx); err != nil {
			fmt.Fprintln(stderr, "pai-runtime: isolation was not verified:", err)
			return 125
		}
		return 0
	}
	// Avoid flag's default usage/error output, which can echo sensitive argv.
	prepare := len(args) == 3 && args[0] == "--prepare-inputs" && args[1] == "--contract"
	execute := len(args) >= 4 && args[0] == "--contract" && args[2] == "--"
	if !prepare && !execute {
		fmt.Fprintln(stderr, "usage: pai-runtime --contract <JSON> -- <program> [args...]\n       pai-runtime --prepare-inputs --contract <JSON>\n       pai-runtime --verify-isolation")
		return 125
	}
	endpoint, token, replica, err := runtimeEnvironment()
	if err != nil {
		fmt.Fprintln(stderr, "pai-runtime:", err)
		return 125
	}
	raw := args[1]
	if prepare {
		raw = args[2]
	}
	c, err := parseContract(raw, replica)
	if err != nil {
		fmt.Fprintln(stderr, "pai-runtime:", err)
		return 125
	}
	// Keep the scoped credential solely in the broker client.
	os.Unsetenv("PAI_RUNTIME_TOKEN")
	o := defaultOptions()
	if !prepare && c.OutputPath != "" {
		o.files, err = fileOptionsFromEnvironment()
		if err != nil {
			fmt.Fprintln(stderr, "pai-runtime:", err)
			return 125
		}
	}
	r := runner{contract: c, replica: replica, broker: newBroker(endpoint, token, o), opts: o,
		stdin: stdin, stdout: stdout, stderr: stderr}
	if prepare {
		return r.prepareInputs(ctx)
	}
	return r.run(ctx, args[3:])
}
