package main

import (
	"errors"
	"os"
	"strconv"
	"time"
)

func checkpointOptionsFromEnvironment(opts options) (options, error) {
	for name, destination := range map[string]*time.Duration{
		"PAI_RUNTIME_CHECKPOINT_TIMEOUT_SECONDS":       &opts.publicationTimeout,
		"PAI_RUNTIME_FINAL_CHECKPOINT_TIMEOUT_SECONDS": &opts.finalTimeout,
	} {
		if value, present := os.LookupEnv(name); present {
			seconds, err := strconv.ParseInt(value, 10, 64)
			if err != nil || !digits.MatchString(value) || seconds < 1 || seconds > 21600 {
				return opts, errors.New("invalid " + name + "; require 1 through 21600 seconds")
			}
			*destination = time.Duration(seconds) * time.Second
		}
	}
	return opts, nil
}
