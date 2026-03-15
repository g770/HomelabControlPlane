// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements logger test behavior for the lab agent.
package logging

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestParseLevelVariants implements test parse level variants.
func TestParseLevelVariants(t *testing.T) {
	t.Parallel()

	cases := map[string]slog.Level{
		"error":   slog.LevelError,
		"warn":    slog.LevelWarn,
		"debug":   slog.LevelDebug,
		"trace":   LevelTrace,
		"info":    slog.LevelInfo,
		"invalid": slog.LevelInfo,
	}

	for raw, expected := range cases {
		if got := parseLevel(raw); got != expected {
			t.Fatalf("parseLevel(%q)=%v, want %v", raw, got, expected)
		}
	}
}

// TestLoggerWritesAllLevelsAndRedactsSecrets implements test logger writes all levels and redacts secrets.
func TestLoggerWritesAllLevelsAndRedactsSecrets(t *testing.T) {
	t.Parallel()

	filePath := filepath.Join(t.TempDir(), "agent.log")
	logger, err := New(Config{
		ServiceName:         "agent",
		Level:               "trace",
		FilePath:            filePath,
		LogToStdout:         false,
		LogToFile:           true,
		RotateFileSizeBytes: 1024,
		RetentionDays:       7,
		MaxBytes:            4096,
	})
	if err != nil {
		t.Fatalf("New failed: %v", err)
	}

	logger.Trace("trace Bearer secret-token", slog.String("authorization", "Bearer top-secret"))
	logger.Debug("debug eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig")
	logger.Info("info", slog.String("cookie", "session=abc123"))
	logger.Warn("warn", slog.String("apikey", "pk-secret-key"))
	logger.Error("error")
	logger.Close()

	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}
	text := string(data)
	for _, snippet := range []string{"trace", "debug", "info", "warn", "error"} {
		if !strings.Contains(text, snippet) {
			t.Fatalf("expected log output to contain %q: %s", snippet, text)
		}
	}
	for _, secret := range []string{"top-secret", "session=abc123", "pk-secret-key"} {
		if strings.Contains(text, secret) {
			t.Fatalf("expected %q to be redacted: %s", secret, text)
		}
	}
	if !strings.Contains(text, "[REDACTED]") || !strings.Contains(text, "[REDACTED_JWT]") {
		t.Fatalf("expected redaction markers in log output: %s", text)
	}
}

// TestRotatingFileWriterRotatesAndPrunes implements test rotating file writer rotates and prunes.
func TestRotatingFileWriterRotatesAndPrunes(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	filePath := filepath.Join(dir, "agent.log")
	stalePath := filepath.Join(dir, "agent.20000101-000000.1.log")
	if err := os.WriteFile(filePath, []byte(strings.Repeat("a", 32)), 0o644); err != nil {
		t.Fatalf("WriteFile active failed: %v", err)
	}
	if err := os.WriteFile(stalePath, []byte("legacy"), 0o644); err != nil {
		t.Fatalf("WriteFile stale failed: %v", err)
	}
	staleTime := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(stalePath, staleTime, staleTime); err != nil {
		t.Fatalf("Chtimes failed: %v", err)
	}

	writer, err := newRotatingFileWriter(filePath, 16, 1, 128)
	if err != nil {
		t.Fatalf("newRotatingFileWriter failed: %v", err)
	}
	defer writer.Close()

	writer.mu.Lock()
	firstCandidate, err := writer.nextRotationPathLocked()
	writer.mu.Unlock()
	if err != nil {
		t.Fatalf("nextRotationPathLocked first failed: %v", err)
	}
	if err := os.WriteFile(firstCandidate, []byte("collision"), 0o644); err != nil {
		t.Fatalf("WriteFile collision failed: %v", err)
	}

	writer.mu.Lock()
	secondCandidate, err := writer.nextRotationPathLocked()
	writer.mu.Unlock()
	if err != nil {
		t.Fatalf("nextRotationPathLocked second failed: %v", err)
	}
	if firstCandidate == secondCandidate {
		t.Fatalf("expected rotation candidate to advance after collision: %s", firstCandidate)
	}

	if _, err := writer.Write([]byte("bbbbbbbbbbbbbbbb")); err != nil {
		t.Fatalf("Write failed: %v", err)
	}

	if _, err := os.Stat(stalePath); !os.IsNotExist(err) {
		t.Fatalf("expected stale rotated file to be pruned, got err=%v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir failed: %v", err)
	}
	rotatedCount := 0
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "agent.") && strings.HasSuffix(entry.Name(), ".log") {
			rotatedCount++
		}
	}
	if rotatedCount == 0 {
		t.Fatalf("expected at least one rotated log file in %s", dir)
	}
}

// TestNewFallsBackWhenFileOutputCannotInitialize implements test new falls back when file output cannot initialize.
func TestNewFallsBackWhenFileOutputCannotInitialize(t *testing.T) {
	blockingPath := filepath.Join(t.TempDir(), "occupied")
	if err := os.WriteFile(blockingPath, []byte("occupied"), 0o644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	logger, err := New(Config{
		ServiceName:         "agent",
		Level:               "info",
		FilePath:            filepath.Join(blockingPath, "agent.log"),
		LogToStdout:         false,
		LogToFile:           true,
		RotateFileSizeBytes: 16,
		RetentionDays:       1,
		MaxBytes:            16,
	})
	if err != nil {
		t.Fatalf("expected logger construction to fall back without error: %v", err)
	}
	logger.Close()
}
