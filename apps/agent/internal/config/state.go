// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements state behavior for the lab agent.
package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const AgentStateSchemaVersion = 1
const RecoveryKeyAlg = "ED25519"

type AgentState struct {
	SchemaVersion       int    `json:"schemaVersion"`
	AgentID             string `json:"agentId"`
	AgentToken          string `json:"agentToken"`
	RecoveryPrivateKey  string `json:"recoveryPrivateKey,omitempty"`
	RecoveryCertificate string `json:"recoveryCertificate,omitempty"`
}

// LoadAgentState implements load agent state.
func LoadAgentState(path string) (AgentState, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return AgentState{}, err
	}

	var state AgentState
	if err := json.Unmarshal(data, &state); err != nil {
		return AgentState{}, err
	}
	if state.SchemaVersion == 0 {
		state.SchemaVersion = AgentStateSchemaVersion
	}
	return state, nil
}

// LoadAgentStateIfExists implements load agent state if exists.
func LoadAgentStateIfExists(path string) (AgentState, bool, error) {
	state, err := LoadAgentState(path)
	if err == nil {
		return state, true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return AgentState{SchemaVersion: AgentStateSchemaVersion}, false, nil
	}
	return AgentState{}, false, err
}

// SaveAgentState implements save agent state.
func SaveAgentState(path string, state AgentState) error {
	trimmedPath := strings.TrimSpace(path)
	if trimmedPath == "" {
		return errors.New("state file path is required")
	}
	state.SchemaVersion = AgentStateSchemaVersion

	dir := filepath.Dir(trimmedPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	tmpFile, err := os.CreateTemp(dir, ".agent-state-*.json")
	if err != nil {
		return err
	}
	tmpPath := tmpFile.Name()
	defer func() {
		_ = os.Remove(tmpPath)
	}()

	if _, err := tmpFile.Write(data); err != nil {
		_ = tmpFile.Close()
		return err
	}
	if err := tmpFile.Chmod(0o600); err != nil {
		_ = tmpFile.Close()
		return err
	}
	if err := tmpFile.Close(); err != nil {
		return err
	}

	return os.Rename(tmpPath, trimmedPath)
}

// HasRuntimeCredentials implements has runtime credentials.
func (s AgentState) HasRuntimeCredentials() bool {
	return strings.TrimSpace(s.AgentID) != "" && strings.TrimSpace(s.AgentToken) != ""
}

// EnsureRecoveryKey implements ensure recovery key.
func (s *AgentState) EnsureRecoveryKey() (string, error) {
	if strings.TrimSpace(s.RecoveryPrivateKey) == "" {
		_, privateKey, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return "", err
		}
		s.RecoveryPrivateKey = base64.StdEncoding.EncodeToString(privateKey)
	}
	return s.RecoveryPublicKey()
}

// RecoveryPublicKey implements recovery public key.
func (s AgentState) RecoveryPublicKey() (string, error) {
	privateKey, err := s.recoveryPrivateKey()
	if err != nil {
		return "", err
	}
	publicKey, ok := privateKey.Public().(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return "", errors.New("invalid recovery public key")
	}
	return base64.StdEncoding.EncodeToString(publicKey), nil
}

// SignRecoveryClaim implements sign recovery claim.
func (s AgentState) SignRecoveryClaim(message string) (string, error) {
	privateKey, err := s.recoveryPrivateKey()
	if err != nil {
		return "", err
	}
	signature := ed25519.Sign(privateKey, []byte(message))
	return base64.StdEncoding.EncodeToString(signature), nil
}

// recoveryPrivateKey implements recovery private key.
func (s AgentState) recoveryPrivateKey() (ed25519.PrivateKey, error) {
	encoded := strings.TrimSpace(s.RecoveryPrivateKey)
	if encoded == "" {
		return nil, errors.New("recovery private key is required")
	}

	privateKeyBytes, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, errors.New("recovery private key must be base64")
	}
	switch len(privateKeyBytes) {
	case ed25519.SeedSize:
		return ed25519.NewKeyFromSeed(privateKeyBytes), nil
	case ed25519.PrivateKeySize:
		return ed25519.PrivateKey(privateKeyBytes), nil
	default:
		return nil, errors.New("recovery private key must be a 32-byte seed or 64-byte Ed25519 private key")
	}
}

// defaultStateFilePath implements default state file path.
func defaultStateFilePath() string {
	if os.Geteuid() == 0 {
		return "/var/lib/homelab/agent/state.json"
	}
	if xdgState := strings.TrimSpace(os.Getenv("XDG_STATE_HOME")); xdgState != "" {
		return filepath.Join(xdgState, "homelab", "agent-state.json")
	}
	if homeDir, err := os.UserHomeDir(); err == nil && strings.TrimSpace(homeDir) != "" {
		return filepath.Join(homeDir, ".local", "state", "homelab", "agent-state.json")
	}
	return ".labagent-state.json"
}
