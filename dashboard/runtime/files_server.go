package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

type fileOptions struct {
	address         string
	maxBytes        int64
	transferTimeout time.Duration
}

func defaultFileOptions() fileOptions {
	return fileOptions{address: "127.0.0.1:8077", maxBytes: maxFileBytes, transferTimeout: 15 * time.Minute}
}
func fileOptionsFromEnvironment() (fileOptions, error) {
	opts := defaultFileOptions()
	if value := os.Getenv("PAI_RUNTIME_FILES_MAX_BYTES"); value != "" {
		n, err := strconv.ParseInt(value, 10, 64)
		if err != nil || n < 1 || n > maxFileBytes || !digits.MatchString(value) {
			return opts, errors.New("invalid PAI_RUNTIME_FILES_MAX_BYTES; require 1 through 5368709120")
		}
		opts.maxBytes = n
	}
	return opts, nil
}

type fileService struct {
	listener net.Listener
	server   *http.Server
	handler  *fileHandler
	served   chan struct{}
	closed   chan struct{}
	once     sync.Once
}

func startFileService(ctx context.Context, root string, opts fileOptions, onFailure func(error)) (*fileService, error) {
	host, port, err := net.SplitHostPort(opts.address)
	if err != nil || host != "127.0.0.1" || port == "" {
		return nil, errors.New("file service must listen on IPv4 loopback")
	}
	handler, err := newFileHandler(ctx, root, opts)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp4", opts.address)
	if err != nil {
		handler.Close()
		return nil, errors.New("cannot bind loopback file service")
	}
	s := &fileService{listener: listener, handler: handler, served: make(chan struct{}), closed: make(chan struct{})}
	s.server = &http.Server{
		Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: opts.transferTimeout, WriteTimeout: opts.transferTimeout,
		IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024, ErrorLog: log.New(io.Discard, "", 0),
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	go func() {
		err := s.server.Serve(listener)
		close(s.served)
		if err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) && onFailure != nil {
			onFailure(errors.New("loopback file listener failed"))
		}
	}()
	go func() {
		select {
		case <-ctx.Done():
			s.Close()
		case <-s.closed:
		}
	}()
	return s, nil
}
func (s *fileService) Close() {
	s.once.Do(func() {
		s.handler.beginClose()
		s.server.Close()
		s.listener.Close()
		<-s.served
		s.handler.Close()
		close(s.closed)
	})
}
