// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements main test behavior for the lab agent.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"homelab/labagent/internal/config"
	"homelab/labagent/internal/controlplane"
	"homelab/labagent/internal/discovery"
	"homelab/labagent/internal/tools"
)

// TestMapAndStructConversionHelpers implements test map and struct conversion helpers.
func TestMapAndStructConversionHelpers(t *testing.T) {
	t.Parallel()

	facts := discovery.Facts{
		Hostname: "node-1",
		CPUPct:   12.5,
	}
	factsMap := mustMap(facts)
	if factsMap["hostname"] != "node-1" {
		t.Fatalf("unexpected facts map: %+v", factsMap)
	}
	restoredFacts := mustFacts(factsMap)
	if restoredFacts.Hostname != "node-1" {
		t.Fatalf("unexpected restored facts: %+v", restoredFacts)
	}

	inventory := discovery.Inventory{
		Hostname: "node-1",
		Services: []map[string]interface{}{{"name": "api"}},
	}
	inventoryMap := mustMap(inventory)
	restoredInventory := mustInventory(inventoryMap)
	if restoredInventory.Hostname != "node-1" {
		t.Fatalf("unexpected restored inventory: %+v", restoredInventory)
	}
}

// TestTelemetryIntervalValidationAndClamping implements test telemetry interval validation and clamping.
func TestTelemetryIntervalValidationAndClamping(t *testing.T) {
	t.Parallel()

	if err := validateTelemetryInterval(4); err == nil {
		t.Fatal("expected validation error below minimum")
	}
	if err := validateTelemetryInterval(5000); err == nil {
		t.Fatal("expected validation error above maximum")
	}
	if err := validateTelemetryInterval(30); err != nil {
		t.Fatalf("unexpected interval validation error: %v", err)
	}

	if got := clampInterval(1); got != telemetryMinIntervalSec {
		t.Fatalf("expected clamped min interval, got %d", got)
	}
	if got := clampInterval(7200); got != telemetryMaxIntervalSec {
		t.Fatalf("expected clamped max interval, got %d", got)
	}
	if got := clampInterval(45); got != 45 {
		t.Fatalf("expected unchanged interval, got %d", got)
	}
}

// TestTelemetryControllerBehavior implements test telemetry controller behavior.
func TestTelemetryControllerBehavior(t *testing.T) {
	t.Parallel()

	controller := newTelemetryController(config.RunConfig{
		HeartbeatSec: 1,
		FactsSec:     30,
		InventorySec: 9000,
	})
	initial := controller.snapshot()
	if initial.HeartbeatSec != telemetryMinIntervalSec {
		t.Fatalf("expected clamped heartbeat interval, got %d", initial.HeartbeatSec)
	}
	if initial.InventorySec != telemetryMaxIntervalSec {
		t.Fatalf("expected clamped inventory interval, got %d", initial.InventorySec)
	}

	updatedConfig, err := controller.setConfig(tools.TelemetryConfigPatch{
		HeartbeatSec: intPtr(20),
		FactsSec:     intPtr(120),
	})
	if err != nil {
		t.Fatalf("setConfig failed: %v", err)
	}
	if updatedConfig.HeartbeatSec != 20 || updatedConfig.FactsSec != 120 {
		t.Fatalf("unexpected updated config: %+v", updatedConfig)
	}

	if _, err := controller.setConfig(tools.TelemetryConfigPatch{
		HeartbeatSec: intPtr(1),
	}); err == nil {
		t.Fatal("expected validation error for invalid telemetry update")
	}

	if !controller.requestRefresh("manual") {
		t.Fatal("expected refresh to be queued")
	}
	if controller.requestRefresh("next") {
		t.Fatal("expected refresh queue to reject when full")
	}
}

// TestSendHeartbeat implements test send heartbeat.
func TestSendHeartbeat(t *testing.T) {
	t.Parallel()

	var capturedPath string
	var capturedAuth string
	var capturedPayload map[string]interface{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&capturedPayload)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := controlplane.NewClient(server.URL)
	state := tools.NewRuntimeState()
	executor := tools.NewExecutor(state)
	identity := newTestIdentity(t, "agent-1", "token-1", "")

	if err := sendHeartbeat(context.Background(), client, identity, executor); err != nil {
		t.Fatalf("sendHeartbeat failed: %v", err)
	}
	if capturedPath != "/api/agents/agent-1/heartbeat" {
		t.Fatalf("unexpected heartbeat path: %s", capturedPath)
	}
	if capturedAuth != "Bearer token-1" {
		t.Fatalf("unexpected auth header: %s", capturedAuth)
	}
	if capturedPayload["status"] != "ONLINE" {
		t.Fatalf("unexpected heartbeat payload: %+v", capturedPayload)
	}
}

// TestCollectAndSendFactsAndInventory implements test collect and send facts and inventory.
func TestCollectAndSendFactsAndInventory(t *testing.T) {
	t.Parallel()

	factsCalls := 0
	inventoryCalls := 0
	eventsCalls := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/facts"):
			factsCalls++
		case strings.Contains(r.URL.Path, "/inventory"):
			inventoryCalls++
		case strings.Contains(r.URL.Path, "/events"):
			eventsCalls++
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := controlplane.NewClient(server.URL)
	collector := discovery.NewCollector()
	state := tools.NewRuntimeState()
	identity := newTestIdentity(t, "agent-1", "token-1", "")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := collectAndSendFacts(ctx, client, identity, collector, state); err != nil {
		t.Fatalf("collectAndSendFacts failed: %v", err)
	}
	if err := collectAndSendInventory(ctx, client, identity, collector, state); err != nil {
		t.Fatalf("collectAndSendInventory failed: %v", err)
	}

	if factsCalls == 0 {
		t.Fatal("expected at least one facts call")
	}
	if inventoryCalls == 0 {
		t.Fatal("expected at least one inventory call")
	}
	_ = eventsCalls // events are optional based on telemetry state.
}

// TestEnrollSuccess implements test enroll success.
func TestEnrollSuccess(t *testing.T) {
	enrollCalls := 0
	statePath := filepath.Join(t.TempDir(), "agent-state.json")
	originalFactory := newControlPlaneClient
	t.Cleanup(func() {
		newControlPlaneClient = originalFactory
	})
	newControlPlaneClient = func(_ string) *controlplane.Client {
		return controlplane.NewClientWithHTTPClient("http://control-plane.test", &http.Client{
			Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path != "/api/agents/enroll" {
					t.Fatalf("unexpected path: %s", r.URL.Path)
				}
				enrollCalls++
				var payload controlplane.EnrollRequest
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Fatalf("decode enroll payload: %v", err)
				}
				if payload.RecoveryKeyAlg != config.RecoveryKeyAlg || payload.RecoveryPublicKey == "" {
					t.Fatalf("expected recovery identity in enroll payload: %+v", payload)
				}
				return jsonHTTPResponse(http.StatusOK, controlplane.EnrollResponse{
					AgentID:             "agent-1",
					AgentToken:          "token-1",
					RecoveryCertificate: "cert-1",
				})
			}),
		})
	}

	err := enroll([]string{
		"--control-plane", "http://control-plane.test",
		"--token", "enroll-token",
		"--mcp-bind", "127.0.0.1",
		"--mcp-port", "8081",
		"--state-file", statePath,
	})
	if err != nil {
		t.Fatalf("enroll failed: %v", err)
	}
	if enrollCalls != 1 {
		t.Fatalf("expected one enroll call, got %d", enrollCalls)
	}
	state, err := config.LoadAgentState(statePath)
	if err != nil {
		t.Fatalf("LoadAgentState failed: %v", err)
	}
	if state.AgentID != "agent-1" || state.AgentToken != "token-1" || state.RecoveryCertificate != "cert-1" {
		t.Fatalf("unexpected persisted state: %+v", state)
	}
}

// TestMainVersionAndStatusCommands implements test main version and status commands.
func TestMainVersionAndStatusCommands(t *testing.T) {
	t.Parallel()

	cases := [][]string{
		{"labagent", "version"},
		{"labagent", "status"},
	}
	for _, args := range cases {
		args := args
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			originalArgs := os.Args
			originalStdout := os.Stdout
			defer func() {
				os.Args = originalArgs
				os.Stdout = originalStdout
			}()
			os.Args = args

			reader, writer, err := os.Pipe()
			if err != nil {
				t.Fatalf("create stdout pipe: %v", err)
			}
			os.Stdout = writer
			main()
			_ = writer.Close()
			var output bytes.Buffer
			_, _ = io.Copy(&output, reader)
			_ = reader.Close()
			if output.Len() == 0 {
				t.Fatalf("expected stdout output for args %v", args)
			}
		})
	}
}

// TestTelemetryPublishUpdateDropsOldestWhenFull implements test telemetry publish update drops oldest when full.
func TestTelemetryPublishUpdateDropsOldestWhenFull(t *testing.T) {
	t.Parallel()

	controller := newTelemetryController(config.RunConfig{
		HeartbeatSec: 15,
		FactsSec:     60,
		InventorySec: 90,
	})

	first := telemetryIntervals{HeartbeatSec: 10, FactsSec: 20, InventorySec: 30, UpdatedAt: time.Now().UTC()}
	second := telemetryIntervals{HeartbeatSec: 11, FactsSec: 21, InventorySec: 31, UpdatedAt: time.Now().UTC()}
	controller.publishUpdate(first)
	controller.publishUpdate(second)

	select {
	case latest := <-controller.updates():
		if latest.HeartbeatSec != second.HeartbeatSec {
			t.Fatalf("expected latest interval payload, got %+v", latest)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected update payload in channel")
	}
}

// TestRunWithContextStartsAndShutsDown implements test run with context starts and shuts down.
func TestRunWithContextStartsAndShutsDown(t *testing.T) {
	t.Parallel()

	heartbeatCalls := 0
	factsCalls := 0
	inventoryCalls := 0
	eventsCalls := 0
	inventorySent := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/heartbeat"):
			heartbeatCalls++
		case strings.Contains(r.URL.Path, "/facts"):
			factsCalls++
		case strings.Contains(r.URL.Path, "/inventory"):
			inventoryCalls++
			select {
			case inventorySent <- struct{}{}:
			default:
			}
		case strings.Contains(r.URL.Path, "/events"):
			eventsCalls++
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		select {
		case <-inventorySent:
		case <-time.After(2 * time.Second):
		}
		cancel()
	}()

	err := runWithContext(ctx, config.RunConfig{
		ControlPlane:   server.URL,
		AgentID:        "agent-1",
		AgentToken:     "token-1",
		MCPBind:        "127.0.0.1",
		MCPPort:        0,
		StateFile:      filepath.Join(t.TempDir(), "agent-state.json"),
		AllowedOrigins: []string{"http://localhost:5173"},
		HeartbeatSec:   1,
		FactsSec:       1,
		InventorySec:   1,
	})
	if err != nil {
		t.Fatalf("runWithContext failed: %v", err)
	}
	if heartbeatCalls == 0 || factsCalls == 0 || inventoryCalls == 0 {
		t.Fatalf("expected initial telemetry calls, got heartbeat=%d facts=%d inventory=%d events=%d", heartbeatCalls, factsCalls, inventoryCalls, eventsCalls)
	}
}

// TestRunWithContextProcessesTelemetryRPC implements test run with context processes telemetry rpc.
func TestRunWithContextProcessesTelemetryRPC(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	port := reservePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runWithContext(ctx, config.RunConfig{
			ControlPlane:   server.URL,
			AgentID:        "agent-1",
			AgentToken:     "token-1",
			MCPBind:        "127.0.0.1",
			MCPPort:        port,
			StateFile:      filepath.Join(t.TempDir(), "agent-state.json"),
			AllowedOrigins: []string{"http://localhost:5173"},
			HeartbeatSec:   1,
			FactsSec:       1,
			InventorySec:   1,
		})
	}()

	mcpURL := fmt.Sprintf("http://127.0.0.1:%d/mcp", port)
	waitForMCPReady(t, mcpURL)

	callMCPTool(t, mcpURL, "token-1", "agent.telemetry.set_config", map[string]interface{}{
		"confirm":      true,
		"heartbeatSec": 2,
		"factsSec":     2,
		"inventorySec": 2,
	})
	callMCPTool(t, mcpURL, "token-1", "agent.telemetry.refresh_now", map[string]interface{}{
		"confirm": true,
		"reason":  "test-refresh",
	})

	time.Sleep(300 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runWithContext returned error: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("runWithContext did not stop after cancel")
	}
}

// intPtr implements int ptr.
func intPtr(value int) *int {
	return &value
}

// reservePort implements reserve port.
func reservePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reservePort listen failed: %v", err)
	}
	defer listener.Close()
	addr := listener.Addr().String()
	_, portText, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("reservePort split failed: %v", err)
	}
	port := 0
	if _, err := fmt.Sscanf(portText, "%d", &port); err != nil || port <= 0 {
		t.Fatalf("reservePort parse failed for %q: %v", portText, err)
	}
	return port
}

// waitForMCPReady implements wait for mcpready.
func waitForMCPReady(t *testing.T, url string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Authorization", "Bearer token-1")
		req.Header.Set("Origin", "http://localhost:5173")
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("MCP server did not become ready at %s", url)
}

// callMCPTool implements call mcptool.
func callMCPTool(t *testing.T, url string, token string, name string, arguments map[string]interface{}) {
	t.Helper()
	payload := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      "req-1",
		"method":  "tools/call",
		"params": map[string]interface{}{
			"name":      name,
			"arguments": arguments,
		},
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal rpc payload: %v", err)
	}
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("call MCP tool %s failed: %v", name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("call MCP tool %s unexpected status %d", name, resp.StatusCode)
	}
}

// newTestIdentity implements new test identity.
func newTestIdentity(t *testing.T, agentID string, agentToken string, recoveryCertificate string) *runtimeIdentity {
	t.Helper()

	path := filepath.Join(t.TempDir(), "agent-state.json")
	identity, err := loadRuntimeIdentity(path)
	if err != nil {
		t.Fatalf("loadRuntimeIdentity failed: %v", err)
	}
	if _, err := identity.EnsureRecoveryKey(); err != nil {
		t.Fatalf("EnsureRecoveryKey failed: %v", err)
	}
	if err := identity.ApplyRecoveredCredentials(agentID, agentToken, recoveryCertificate); err != nil {
		t.Fatalf("ApplyRecoveredCredentials failed: %v", err)
	}
	return identity
}
