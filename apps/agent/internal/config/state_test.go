// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements state test behavior for the lab agent.
package config

import (
	"os"
	"path/filepath"
	"testing"
)

// TestAgentStateEnsureRecoveryKeyAndSignClaim implements test agent state ensure recovery key and sign claim.
func TestAgentStateEnsureRecoveryKeyAndSignClaim(t *testing.T) {
	t.Parallel()

	var state AgentState
	publicKey, err := state.EnsureRecoveryKey()
	if err != nil {
		t.Fatalf("EnsureRecoveryKey failed: %v", err)
	}
	if publicKey == "" || state.RecoveryPrivateKey == "" {
		t.Fatalf("expected recovery material to be populated: %+v", state)
	}

	signature, err := state.SignRecoveryClaim("agent-recovery-claim:v1")
	if err != nil {
		t.Fatalf("SignRecoveryClaim failed: %v", err)
	}
	if signature == "" {
		t.Fatal("expected recovery signature")
	}
}

// TestLoadAgentStateIfExists implements test load agent state if exists.
func TestLoadAgentStateIfExists(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "agent-state.json")
	state, exists, err := LoadAgentStateIfExists(path)
	if err != nil {
		t.Fatalf("LoadAgentStateIfExists returned error: %v", err)
	}
	if exists {
		t.Fatal("expected state file to be absent")
	}
	if state.SchemaVersion != AgentStateSchemaVersion {
		t.Fatalf("unexpected schema version: %+v", state)
	}
}

// TestSaveAndLoadAgentState implements test save and load agent state.
func TestSaveAndLoadAgentState(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "agent-state.json")
	input := AgentState{
		AgentID:             "agent-1",
		AgentToken:          "token-1",
		RecoveryCertificate: "cert-1",
	}

	if err := SaveAgentState(path, input); err != nil {
		t.Fatalf("SaveAgentState failed: %v", err)
	}

	loaded, err := LoadAgentState(path)
	if err != nil {
		t.Fatalf("LoadAgentState failed: %v", err)
	}
	if loaded.AgentID != input.AgentID || loaded.AgentToken != input.AgentToken || loaded.RecoveryCertificate != input.RecoveryCertificate {
		t.Fatalf("unexpected loaded state: %+v", loaded)
	}
	if !loaded.HasRuntimeCredentials() {
		t.Fatalf("expected runtime credentials to be present: %+v", loaded)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat failed: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected state file mode 0600, got %o", info.Mode().Perm())
	}
}

// TestSaveAgentStateRequiresPath implements test save agent state requires path.
func TestSaveAgentStateRequiresPath(t *testing.T) {
	t.Parallel()

	if err := SaveAgentState("   ", AgentState{}); err == nil {
		t.Fatal("expected SaveAgentState to reject blank paths")
	}
}

// TestHasRuntimeCredentialsAndDefaultStateFilePath implements test has runtime credentials and default state file path.
func TestHasRuntimeCredentialsAndDefaultStateFilePath(t *testing.T) {
	if (AgentState{AgentID: "agent-1"}).HasRuntimeCredentials() {
		t.Fatal("expected missing token to fail runtime credential check")
	}

	t.Setenv("XDG_STATE_HOME", "/tmp/xdg-state")
	if got := defaultStateFilePath(); got != "/tmp/xdg-state/homelab/agent-state.json" {
		t.Fatalf("unexpected XDG state file path: %s", got)
	}

	t.Setenv("XDG_STATE_HOME", "")
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	if got := defaultStateFilePath(); got != filepath.Join(homeDir, ".local", "state", "homelab", "agent-state.json") {
		t.Fatalf("unexpected HOME-derived state file path: %s", got)
	}
}

// TestRecoveryPublicKeyValidationErrors implements test recovery public key validation errors.
func TestRecoveryPublicKeyValidationErrors(t *testing.T) {
	t.Parallel()

	if _, err := (AgentState{}).RecoveryPublicKey(); err == nil {
		t.Fatal("expected blank recovery key to fail")
	}
	if _, err := (AgentState{RecoveryPrivateKey: "not-base64"}).RecoveryPublicKey(); err == nil {
		t.Fatal("expected invalid base64 recovery key to fail")
	}
	if _, err := (AgentState{RecoveryPrivateKey: "c2hvcnQ="}).RecoveryPublicKey(); err == nil {
		t.Fatal("expected invalid recovery key length to fail")
	}
}
