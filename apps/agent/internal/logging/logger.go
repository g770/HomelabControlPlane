// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements logger behavior for the lab agent.
package logging

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	LevelTrace slog.Level = slog.LevelDebug - 4
)

type Config struct {
	ServiceName         string
	Level               string
	FilePath            string
	LogToStdout         bool
	LogToFile           bool
	RotateFileSizeBytes int64
	RetentionDays       int
	MaxBytes            int64
}

type Logger struct {
	serviceName string
	logger      *slog.Logger
	fileWriter  *rotatingFileWriter
}

type rotatingFileWriter struct {
	mu                  sync.Mutex
	filePath            string
	rotateFileSizeBytes int64
	retentionDays       int
	maxBytes            int64
	file                *os.File
	lastPrune           time.Time
}

var (
	bearerPattern = regexp.MustCompile(`Bearer\s+[A-Za-z0-9._-]+`)
	jwtPattern    = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)
	keyPattern    = regexp.MustCompile(`\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b`)
)

// New implements new.
func New(config Config) (*Logger, error) {
	level := parseLevel(config.Level)
	writers := make([]io.Writer, 0, 2)

	var fileWriter *rotatingFileWriter
	if config.LogToFile {
		writer, err := newRotatingFileWriter(config.FilePath, config.RotateFileSizeBytes, config.RetentionDays, config.MaxBytes)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s level=ERROR service=%s msg=%q reason=%q\n", time.Now().UTC().Format(time.RFC3339), config.ServiceName, "failed to initialize log file output", err.Error())
		} else {
			fileWriter = writer
			writers = append(writers, writer)
		}
	}
	if config.LogToStdout || len(writers) == 0 {
		writers = append(writers, os.Stdout)
	}

	baseWriter := io.MultiWriter(writers...)
	handler := slog.NewTextHandler(baseWriter, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(_ []string, attr slog.Attr) slog.Attr {
			if shouldRedactKey(attr.Key) {
				return slog.String(attr.Key, "[REDACTED]")
			}
			switch attr.Value.Kind() {
			case slog.KindString:
				return slog.String(attr.Key, redactString(attr.Value.String()))
			default:
				return attr
			}
		},
	})

	logger := slog.New(handler).With(
		slog.String("service", config.ServiceName),
	)

	return &Logger{
		serviceName: config.ServiceName,
		logger:      logger,
		fileWriter:  fileWriter,
	}, nil
}

// Trace implements trace.
func (l *Logger) Trace(message string, attrs ...slog.Attr) {
	l.logAttrs(LevelTrace, message, attrs...)
}

// Debug implements debug.
func (l *Logger) Debug(message string, attrs ...slog.Attr) {
	l.logAttrs(slog.LevelDebug, message, attrs...)
}

// Info implements info.
func (l *Logger) Info(message string, attrs ...slog.Attr) {
	l.logAttrs(slog.LevelInfo, message, attrs...)
}

// Warn implements warn.
func (l *Logger) Warn(message string, attrs ...slog.Attr) {
	l.logAttrs(slog.LevelWarn, message, attrs...)
}

// Error implements error.
func (l *Logger) Error(message string, attrs ...slog.Attr) {
	l.logAttrs(slog.LevelError, message, attrs...)
}

// Close implements close.
func (l *Logger) Close() {
	if l.fileWriter != nil {
		_ = l.fileWriter.Close()
	}
}

// logAttrs implements log attrs.
func (l *Logger) logAttrs(level slog.Level, message string, attrs ...slog.Attr) {
	args := make([]any, 0, len(attrs))
	for _, attr := range attrs {
		if shouldRedactKey(attr.Key) {
			args = append(args, slog.String(attr.Key, "[REDACTED]"))
			continue
		}
		if attr.Value.Kind() == slog.KindString {
			args = append(args, slog.String(attr.Key, redactString(attr.Value.String())))
			continue
		}
		args = append(args, attr)
	}
	l.logger.Log(context.Background(), level, redactString(message), args...)
}

// parseLevel parses level.
func parseLevel(raw string) slog.Level {
	normalized := strings.ToLower(strings.TrimSpace(raw))
	switch normalized {
	case "error":
		return slog.LevelError
	case "warn":
		return slog.LevelWarn
	case "debug":
		return slog.LevelDebug
	case "trace":
		return LevelTrace
	case "info":
		fallthrough
	default:
		return slog.LevelInfo
	}
}

// shouldRedactKey checks whether redact key.
func shouldRedactKey(key string) bool {
	normalized := strings.ToLower(strings.TrimSpace(key))
	for _, marker := range []string{"password", "token", "secret", "authorization", "cookie", "apikey", "api_key", "privatekey", "private_key", "credential"} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

// redactString implements redact string.
func redactString(raw string) string {
	redacted := bearerPattern.ReplaceAllString(raw, "Bearer [REDACTED]")
	redacted = jwtPattern.ReplaceAllString(redacted, "[REDACTED_JWT]")
	redacted = keyPattern.ReplaceAllString(redacted, "[REDACTED_KEY]")
	return redacted
}

// newRotatingFileWriter implements new rotating file writer.
func newRotatingFileWriter(filePath string, rotateFileSizeBytes int64, retentionDays int, maxBytes int64) (*rotatingFileWriter, error) {
	writer := &rotatingFileWriter{
		filePath:            filePath,
		rotateFileSizeBytes: rotateFileSizeBytes,
		retentionDays:       retentionDays,
		maxBytes:            maxBytes,
	}
	if err := writer.ensureFileLocked(); err != nil {
		return nil, err
	}
	if err := writer.pruneLocked(time.Now()); err != nil {
		return nil, err
	}
	return writer, nil
}

// Write implements write.
func (w *rotatingFileWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if err := w.ensureFileLocked(); err != nil {
		return 0, err
	}

	if err := w.rotateIfNeededLocked(int64(len(p))); err != nil {
		return 0, err
	}

	n, err := w.file.Write(p)
	if err != nil {
		return n, err
	}

	if w.lastPrune.IsZero() || time.Since(w.lastPrune) >= time.Hour {
		_ = w.pruneLocked(time.Now())
	}

	return n, nil
}

// Close implements close.
func (w *rotatingFileWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	return w.file.Close()
}

// ensureFileLocked implements ensure file locked.
func (w *rotatingFileWriter) ensureFileLocked() error {
	directory := filepath.Dir(w.filePath)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return err
	}
	if w.file != nil {
		return nil
	}
	file, err := os.OpenFile(w.filePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	w.file = file
	return nil
}

// rotateIfNeededLocked implements rotate if needed locked.
func (w *rotatingFileWriter) rotateIfNeededLocked(nextBytes int64) error {
	if w.rotateFileSizeBytes <= 0 {
		return nil
	}
	stats, err := os.Stat(w.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if stats.Size()+nextBytes < w.rotateFileSizeBytes {
		return nil
	}
	if w.file != nil {
		if err := w.file.Close(); err != nil {
			return err
		}
		w.file = nil
	}

	rotatedPath, err := w.nextRotationPathLocked()
	if err != nil {
		return err
	}
	if err := os.Rename(w.filePath, rotatedPath); err != nil {
		return err
	}
	if err := w.ensureFileLocked(); err != nil {
		return err
	}
	return w.pruneLocked(time.Now())
}

// nextRotationPathLocked implements next rotation path locked.
func (w *rotatingFileWriter) nextRotationPathLocked() (string, error) {
	directory := filepath.Dir(w.filePath)
	extension := filepath.Ext(w.filePath)
	base := strings.TrimSuffix(filepath.Base(w.filePath), extension)
	stamp := time.Now().UTC().Format("20060102-150405")
	if extension == "" {
		extension = ".log"
	}

	for suffix := 1; suffix < 10_000; suffix++ {
		candidate := filepath.Join(directory, fmt.Sprintf("%s.%s.%d%s", base, stamp, suffix, extension))
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate, nil
		} else if err != nil {
			return "", err
		}
	}
	return "", fmt.Errorf("could not allocate rotated log filename")
}

// pruneLocked implements prune locked.
func (w *rotatingFileWriter) pruneLocked(now time.Time) error {
	w.lastPrune = now
	directory := filepath.Dir(w.filePath)
	extension := filepath.Ext(w.filePath)
	base := strings.TrimSuffix(filepath.Base(w.filePath), extension)
	activeName := filepath.Base(w.filePath)

	entries, err := os.ReadDir(directory)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	type fileEntry struct {
		path   string
		name   string
		size   int64
		mtime  time.Time
		active bool
	}

	files := make([]fileEntry, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if name != activeName {
			if !strings.HasPrefix(name, base+".") {
				continue
			}
			if extension != "" && !strings.HasSuffix(name, extension) {
				continue
			}
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		files = append(files, fileEntry{
			path:   filepath.Join(directory, name),
			name:   name,
			size:   info.Size(),
			mtime:  info.ModTime(),
			active: name == activeName,
		})
	}

	retentionCutoff := now.Add(-time.Duration(w.retentionDays) * 24 * time.Hour)
	for _, entry := range files {
		if entry.active {
			continue
		}
		if entry.mtime.Before(retentionCutoff) {
			_ = os.Remove(entry.path)
		}
	}

	files = files[:0]
	entries, err = os.ReadDir(directory)
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		name := entry.Name()
		if name != activeName {
			if !strings.HasPrefix(name, base+".") {
				continue
			}
			if extension != "" && !strings.HasSuffix(name, extension) {
				continue
			}
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		files = append(files, fileEntry{
			path:   filepath.Join(directory, name),
			name:   name,
			size:   info.Size(),
			mtime:  info.ModTime(),
			active: name == activeName,
		})
	}

	totalSize := int64(0)
	for _, entry := range files {
		totalSize += entry.size
	}
	if totalSize <= w.maxBytes {
		return nil
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].mtime.Before(files[j].mtime)
	})
	for _, entry := range files {
		if totalSize <= w.maxBytes {
			break
		}
		if entry.active {
			continue
		}
		if err := os.Remove(entry.path); err != nil {
			continue
		}
		totalSize -= entry.size
	}

	return nil
}
