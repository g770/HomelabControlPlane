// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements config test behavior for the lab agent.
package config

import "testing"

// TestParseRun implements test parse run.
func TestParseRun(t *testing.T) {
	cfg, err := ParseRun([]string{
		"--control-plane", "http://localhost:4000",
		"--agent-id", "abc",
		"--agent-token", "def",
		"--mcp-bind", "127.0.0.1",
		"--mcp-port", "8081",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if cfg.AgentID != "abc" {
		t.Fatalf("unexpected agent id: %s", cfg.AgentID)
	}
}

// TestParseRunAllowsStateFileOnlyCredentials implements test parse run allows state file only credentials.
func TestParseRunAllowsStateFileOnlyCredentials(t *testing.T) {
	cfg, err := ParseRun([]string{
		"--control-plane", "http://localhost:4000",
		"--mcp-bind", "127.0.0.1",
		"--mcp-port", "8081",
		"--state-file", "/tmp/agent-state.json",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if cfg.StateFile != "/tmp/agent-state.json" {
		t.Fatalf("unexpected state file: %s", cfg.StateFile)
	}
}

// TestParseEnrollAcceptsAdvertiseURL implements test parse enroll accepts advertise url.
func TestParseEnrollAcceptsAdvertiseURL(t *testing.T) {
	cfg, err := ParseEnroll([]string{
		"--control-plane", "http://localhost:4000",
		"--token", "enroll-token",
		"--mcp-bind", "0.0.0.0",
		"--mcp-port", "8081",
		"--mcp-advertise-url", "http://agent1.lan:8081",
		"--allow-insecure-dev",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if cfg.MCPAdvertiseURL != "http://agent1.lan:8081" {
		t.Fatalf("unexpected advertise url: %s", cfg.MCPAdvertiseURL)
	}
}

// TestParseEnrollRejectsWildcardWithoutAdvertiseURL implements test parse enroll rejects wildcard without advertise url.
func TestParseEnrollRejectsWildcardWithoutAdvertiseURL(t *testing.T) {
	_, err := ParseEnroll([]string{
		"--control-plane", "http://localhost:4000",
		"--token", "enroll-token",
		"--mcp-bind", "0.0.0.0",
		"--mcp-port", "8081",
		"--allow-insecure-dev",
	})
	if err == nil {
		t.Fatal("expected error for wildcard bind without mcp-advertise-url")
	}
}
