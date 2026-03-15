// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements config extra test behavior for the lab agent.
package config

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestParseOriginsAndBindHelpers implements test parse origins and bind helpers.
func TestParseOriginsAndBindHelpers(t *testing.T) {
	t.Parallel()

	origins := parseOrigins(" http://a.local , ,http://b.local ")
	if len(origins) != 2 || origins[0] != "http://a.local" || origins[1] != "http://b.local" {
		t.Fatalf("unexpected parsed origins: %+v", origins)
	}

	if !isLocalBind("127.0.0.1") || !isLocalBind("localhost") || !isLocalBind("::1") {
		t.Fatal("expected localhost bind addresses to be recognized")
	}
	if isLocalBind("0.0.0.0") {
		t.Fatal("did not expect wildcard to be local bind")
	}
	if !isWildcardBind("0.0.0.0") || !isWildcardBind("::") {
		t.Fatal("expected wildcard binds to be recognized")
	}
}

// TestValidateAdvertiseURLAndParseErrors implements test validate advertise urland parse errors.
func TestValidateAdvertiseURLAndParseErrors(t *testing.T) {
	t.Parallel()

	if err := validateAdvertiseURL("http://agent.local:8081"); err != nil {
		t.Fatalf("expected valid advertise url: %v", err)
	}
	if err := validateAdvertiseURL("ftp://agent.local"); err == nil {
		t.Fatal("expected scheme validation error for advertise url")
	}
	if err := validateAdvertiseURL("http://"); err == nil {
		t.Fatal("expected host validation error for advertise url")
	}

	_, err := ParseRun([]string{
		"--control-plane", "http://localhost:4000",
		"--agent-id", "abc",
		"--agent-token", "def",
		"--mcp-bind", "0.0.0.0",
		"--mcp-port", "8081",
	})
	if err == nil || !strings.Contains(err.Error(), "non-localhost") {
		t.Fatalf("expected insecure bind validation error, got %v", err)
	}

	_, err = ParseEnroll([]string{
		"--control-plane", "http://localhost:4000",
		"--token", "enroll-token",
		"--mcp-bind", "0.0.0.0",
		"--mcp-port", "8081",
		"--allow-insecure-dev",
		"--mcp-advertise-url", "ftp://agent.local",
	})
	if err == nil {
		t.Fatal("expected advertise url validation error")
	}
}

// TestSaveRunConfig implements test save run config.
func TestSaveRunConfig(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "run.env")
	err := SaveRunConfig(path, RunConfig{
		AgentID:      "agent-1",
		AgentToken:   "token-1",
		ControlPlane: "http://localhost:4000",
	})
	if err != nil {
		t.Fatalf("SaveRunConfig failed: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read saved config failed: %v", err)
	}
	text := string(data)
	if !strings.Contains(text, "AGENT_ID=agent-1") || !strings.Contains(text, "AGENT_TOKEN=token-1") {
		t.Fatalf("unexpected saved config contents: %q", text)
	}
}

// TestUsageWritesHelpText implements test usage writes help text.
func TestUsageWritesHelpText(t *testing.T) {
	t.Parallel()

	originalStdout := os.Stdout
	defer func() {
		os.Stdout = originalStdout
	}()

	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create stdout pipe: %v", err)
	}
	os.Stdout = writer
	Usage()
	_ = writer.Close()

	var output bytes.Buffer
	_, _ = io.Copy(&output, reader)
	_ = reader.Close()
	if !strings.Contains(output.String(), "labagent commands:") {
		t.Fatalf("unexpected usage output: %q", output.String())
	}
}
