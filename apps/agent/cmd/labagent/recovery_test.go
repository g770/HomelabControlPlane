// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements recovery test behavior for the lab agent.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"homelab/labagent/internal/config"
	"homelab/labagent/internal/controlplane"
	"homelab/labagent/internal/discovery"
	"homelab/labagent/internal/logging"
	"homelab/labagent/internal/mcp"
	"homelab/labagent/internal/tools"
)

// TestResolveRunCredentialsPrefersStateFile implements test resolve run credentials prefers state file.
func TestResolveRunCredentialsPrefersStateFile(t *testing.T) {
	t.Parallel()

	statePath := filepath.Join(t.TempDir(), "agent-state.json")
	state := config.AgentState{
		AgentID:             "state-agent",
		AgentToken:          "state-token",
		RecoveryCertificate: "cert-1",
	}
	if _, err := state.EnsureRecoveryKey(); err != nil {
		t.Fatalf("EnsureRecoveryKey failed: %v", err)
	}
	if err := config.SaveAgentState(statePath, state); err != nil {
		t.Fatalf("SaveAgentState failed: %v", err)
	}

	cfg, identity, err := resolveRunCredentials(config.RunConfig{
		ControlPlane: "http://control-plane.local",
		AgentID:      "cli-agent",
		AgentToken:   "cli-token",
		MCPBind:      "127.0.0.1",
		MCPPort:      8081,
		StateFile:    statePath,
	})
	if err != nil {
		t.Fatalf("resolveRunCredentials failed: %v", err)
	}
	if cfg.AgentID != "state-agent" || cfg.AgentToken != "state-token" {
		t.Fatalf("expected state credentials to win, got %+v", cfg)
	}
	agentID, agentToken := identity.Credentials()
	if agentID != "state-agent" || agentToken != "state-token" {
		t.Fatalf("unexpected runtime identity credentials: %s %s", agentID, agentToken)
	}
}

// TestSendHeartbeatPersistsRecoveryCertificate implements test send heartbeat persists recovery certificate.
func TestSendHeartbeatPersistsRecoveryCertificate(t *testing.T) {
	t.Parallel()

	identity := newTestIdentity(t, "agent-1", "token-1", "")
	state := tools.NewRuntimeState()
	executor := tools.NewExecutor(state)

	client := newFakeControlPlaneClient(t, func(r *http.Request) (*http.Response, error) {
		var payload controlplane.HeartbeatRequest
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode heartbeat payload: %v", err)
		}
		if payload.RecoveryKeyAlg != config.RecoveryKeyAlg || payload.RecoveryPublicKey == "" || !payload.RecoveryCertificateMissing {
			t.Fatalf("expected recovery bootstrap payload, got %+v", payload)
		}
		return jsonHTTPResponse(http.StatusOK, controlplane.HeartbeatResponse{
			OK:                  true,
			RecoveryCertificate: "bootstrap-cert",
		})
	})

	if err := sendHeartbeat(context.Background(), client, identity, executor); err != nil {
		t.Fatalf("sendHeartbeat failed: %v", err)
	}
	updated, err := config.LoadAgentState(identity.path)
	if err != nil {
		t.Fatalf("LoadAgentState failed: %v", err)
	}
	if updated.RecoveryCertificate != "bootstrap-cert" {
		t.Fatalf("expected recovery certificate to persist, got %+v", updated)
	}
}

// TestHandleRuntimeErrorRecoversOrphanedAgent implements test handle runtime error recovers orphaned agent.
func TestHandleRuntimeErrorRecoversOrphanedAgent(t *testing.T) {
	t.Parallel()

	logger := newTestLogger(t)
	identity := newTestIdentity(t, "agent-1", "stale-token", "cert-1")
	collector := discovery.NewCollector()
	runtimeState := tools.NewRuntimeState()
	executor := tools.NewExecutor(runtimeState)
	mcpServer := mcp.NewServer("127.0.0.1", 0, "stale-token", []string{"http://localhost:5173"}, executor)

	var initialHeartbeatCalls atomic.Int32
	var recoveredHeartbeatCalls atomic.Int32
	var factsCalls atomic.Int32
	var inventoryCalls atomic.Int32
	var eventsCalls atomic.Int32
	var ackCalls atomic.Int32

	client := newFakeControlPlaneClient(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/api/agents/reclaim/challenge":
			return jsonHTTPResponse(http.StatusOK, controlplane.ReclaimChallengeResponse{
				ChallengeToken: "challenge-token",
				ExpiresAt:      "2026-03-12T00:00:00Z",
			})
		case "/api/agents/reclaim/claims":
			var payload controlplane.SubmitReclaimClaimRequest
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode reclaim claim payload: %v", err)
			}
			if payload.Signature == "" || payload.RecoveryCertificate != "cert-1" {
				t.Fatalf("unexpected reclaim claim payload: %+v", payload)
			}
			return jsonHTTPResponse(http.StatusOK, controlplane.SubmitReclaimClaimResponse{
				ClaimID:   "claim-1",
				PollToken: "poll-1",
				Status:    controlplane.RecoveryClaimPendingApproval,
			})
		case "/api/agents/reclaim/claims/claim-1/status":
			return jsonHTTPResponse(http.StatusOK, controlplane.ReclaimStatusResponse{
				Status:              controlplane.RecoveryClaimApproved,
				AgentID:             "agent-2",
				AgentToken:          "token-2",
				RecoveryCertificate: "cert-2",
			})
		case "/api/agents/reclaim/claims/claim-1/ack":
			ackCalls.Add(1)
			return jsonHTTPResponse(http.StatusOK, controlplane.ReclaimAckResponse{OK: true})
		case "/api/agents/agent-2/heartbeat":
			recoveredHeartbeatCalls.Add(1)
			return &http.Response{
				StatusCode: http.StatusNoContent,
				Body:       io.NopCloser(strings.NewReader("")),
				Header:     make(http.Header),
			}, nil
		case "/api/agents/agent-2/facts":
			factsCalls.Add(1)
			return &http.Response{
				StatusCode: http.StatusNoContent,
				Body:       io.NopCloser(strings.NewReader("")),
				Header:     make(http.Header),
			}, nil
		case "/api/agents/agent-2/inventory":
			inventoryCalls.Add(1)
			return &http.Response{
				StatusCode: http.StatusNoContent,
				Body:       io.NopCloser(strings.NewReader("")),
				Header:     make(http.Header),
			}, nil
		case "/api/agents/agent-2/events":
			eventsCalls.Add(1)
			return &http.Response{
				StatusCode: http.StatusNoContent,
				Body:       io.NopCloser(strings.NewReader("")),
				Header:     make(http.Header),
			}, nil
		case "/api/agents/agent-1/heartbeat":
			initialHeartbeatCalls.Add(1)
			return jsonHTTPResponse(http.StatusUnauthorized, map[string]interface{}{
				"statusCode": 401,
				"message":    "Agent not registered",
				"code":       controlplane.AgentNotRegisteredCode,
			})
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
			return nil, nil
		}
	})

	err := handleRuntimeError(
		context.Background(),
		logger,
		client,
		config.RunConfig{
			ControlPlane:    "http://control-plane.test",
			MCPBind:         "127.0.0.1",
			MCPPort:         8081,
			MCPAdvertiseURL: "http://127.0.0.1:8081",
			StateFile:       identity.path,
			AllowedOrigins:  []string{"http://localhost:5173"},
		},
		identity,
		collector,
		runtimeState,
		executor,
		mcpServer,
		&controlplane.RequestError{
			StatusCode: 401,
			Message:    "Agent not registered",
			Code:       controlplane.AgentNotRegisteredCode,
		},
	)
	if err != nil {
		t.Fatalf("handleRuntimeError failed: %v", err)
	}

	agentID, agentToken := identity.Credentials()
	if agentID != "agent-2" || agentToken != "token-2" {
		t.Fatalf("expected recovered credentials, got %s %s", agentID, agentToken)
	}
	state, err := config.LoadAgentState(identity.path)
	if err != nil {
		t.Fatalf("LoadAgentState failed: %v", err)
	}
	if state.RecoveryCertificate != "cert-2" {
		t.Fatalf("expected updated recovery certificate, got %+v", state)
	}
	if initialHeartbeatCalls.Load() != 0 {
		t.Fatalf("expected reclaim to handle only the orphan error path, got %d initial heartbeat calls", initialHeartbeatCalls.Load())
	}
	if recoveredHeartbeatCalls.Load() == 0 || factsCalls.Load() == 0 || inventoryCalls.Load() == 0 || ackCalls.Load() == 0 {
		t.Fatalf(
			"expected post-recovery sync and ack, got heartbeat=%d facts=%d inventory=%d events=%d ack=%d",
			recoveredHeartbeatCalls.Load(),
			factsCalls.Load(),
			inventoryCalls.Load(),
			eventsCalls.Load(),
			ackCalls.Load(),
		)
	}
}

// newTestLogger implements new test logger.
func newTestLogger(t *testing.T) *logging.Logger {
	t.Helper()

	logger, err := logging.New(logging.Config{
		ServiceName:         "agent-test",
		Level:               "debug",
		FilePath:            filepath.Join(t.TempDir(), "agent.log"),
		LogToStdout:         false,
		LogToFile:           true,
		RotateFileSizeBytes: 1024 * 1024,
		RetentionDays:       1,
		MaxBytes:            1024 * 1024,
	})
	if err != nil {
		t.Fatalf("logging.New failed: %v", err)
	}
	t.Cleanup(logger.Close)
	return logger
}

// TestBuildAgentEndpoints implements test build agent endpoints.
func TestBuildAgentEndpoints(t *testing.T) {
	t.Parallel()

	endpoint, mcpEndpoint := buildAgentEndpoints("::1", 8081, "")
	if !strings.Contains(endpoint, "[::1]:8081") || mcpEndpoint != endpoint+"/mcp" {
		t.Fatalf("unexpected endpoints: %s %s", endpoint, mcpEndpoint)
	}
}

// newFakeControlPlaneClient implements new fake control plane client.
func newFakeControlPlaneClient(t *testing.T, handler func(*http.Request) (*http.Response, error)) *controlplane.Client {
	t.Helper()

	return controlplane.NewClientWithHTTPClient("http://control-plane.test", &http.Client{
		Transport: roundTripFunc(handler),
	})
}

// jsonHTTPResponse implements json httpresponse.
func jsonHTTPResponse(statusCode int, body interface{}) (*http.Response, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return &http.Response{
		StatusCode: statusCode,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(bytes.NewReader(data)),
	}, nil
}

type roundTripFunc func(*http.Request) (*http.Response, error)

// RoundTrip implements round trip.
func (fn roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return fn(r)
}
