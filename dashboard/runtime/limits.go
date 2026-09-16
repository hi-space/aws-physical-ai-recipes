package main

// Keep server/runtime/limits.ts aligned. File-browser transfers retain their
// independent 5 GiB bound; checkpoint multipart transfers may be much larger.
const (
	maxCheckpointFileBytes int64 = 1 << 40
	maxCheckpointMetadata        = 300000
	maxPlanFiles                 = 1024
	planPageFiles                = 64
	maxMultipartParts            = 10000
	minMultipartPartBytes  int64 = 5 << 20
)
