// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements tools test behavior for the lab agent.
package tools

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestRuntimeStateSnapshotDeepCopy implements test runtime state snapshot deep copy.
func TestRuntimeStateSnapshotDeepCopy(t *testing.T) {
	t.Parallel()

	state := NewRuntimeState()
	state.UpdateFacts(map[string]interface{}{
		"hostname": "node-1",
		"snapshot": map[string]interface{}{
			"network": map[string]interface{}{"primaryIp": "127.0.0.1"},
		},
	})
	state.UpdateInventory(map[string]interface{}{
		"services": []interface{}{"api"},
	})
	state.AppendEvents([]map[string]interface{}{{"type": "event-1"}})

	facts, inventory, events := state.Snapshot()
	facts["hostname"] = "mutated"
	inventory["services"] = []interface{}{"changed"}
	events[0]["type"] = "mutated"

	nextFacts, nextInventory, nextEvents := state.Snapshot()
	if got := nextFacts["hostname"]; got != "node-1" {
		t.Fatalf("facts mutated via snapshot copy: %v", got)
	}
	if got := nextInventory["services"].([]interface{})[0]; got != "api" {
		t.Fatalf("inventory mutated via snapshot copy: %v", got)
	}
	if got := nextEvents[0]["type"]; got != "event-1" {
		t.Fatalf("events mutated via snapshot copy: %v", got)
	}
}

// TestExecutorResourceAndToolBasics implements test executor resource and tool basics.
func TestExecutorResourceAndToolBasics(t *testing.T) {
	t.Parallel()

	state := NewRuntimeState()
	state.UpdateFacts(map[string]interface{}{
		"hostname": "node-1",
		"cpuPct":   25.0,
		"memPct":   30.0,
		"diskPct":  40.0,
	})
	state.UpdateInventory(map[string]interface{}{
		"services":   []interface{}{"svc-a"},
		"containers": []interface{}{"ctr-a"},
	})
	executor := NewExecutor(state)

	if len(executor.ListTools()) == 0 {
		t.Fatal("expected non-empty tool list")
	}
	if len(executor.ListResources()) == 0 {
		t.Fatal("expected non-empty resource list")
	}
	if len(executor.ListPrompts()) == 0 {
		t.Fatal("expected non-empty prompt list")
	}

	resource, err := executor.GetResource("host://metrics/summary")
	if err != nil {
		t.Fatalf("GetResource failed: %v", err)
	}
	data := resource["data"].(map[string]interface{})
	if data["cpuPct"] != 25.0 {
		t.Fatalf("unexpected metrics payload: %+v", data)
	}

	_, err = executor.GetResource("host://unknown")
	if err == nil {
		t.Fatal("expected unknown resource error")
	}

	_, err = executor.CallTool(context.Background(), "unknown.tool", map[string]interface{}{})
	if err == nil {
		t.Fatal("expected unknown tool error")
	}
}

// TestGetResourceAllSupportedURIs implements test get resource all supported uris.
func TestGetResourceAllSupportedURIs(t *testing.T) {
	t.Parallel()

	state := NewRuntimeState()
	state.UpdateFacts(map[string]interface{}{
		"cpuPct":  11.0,
		"memPct":  22.0,
		"diskPct": 33.0,
	})
	state.UpdateInventory(map[string]interface{}{
		"services":   []interface{}{"svc-a"},
		"containers": []interface{}{"ctr-a"},
	})
	state.AppendEvents([]map[string]interface{}{{"type": "evt-a"}})
	executor := NewExecutor(state)

	for _, uri := range []string{"host://facts", "host://services", "host://containers", "host://metrics/summary", "host://events/recent"} {
		resp, err := executor.GetResource(uri)
		if err != nil {
			t.Fatalf("GetResource(%s) failed: %v", uri, err)
		}
		if resp["uri"] != uri {
			t.Fatalf("unexpected uri echo for %s: %+v", uri, resp)
		}
	}
}

// TestCallToolDispatchCases implements test call tool dispatch cases.
func TestCallToolDispatchCases(t *testing.T) {
	t.Parallel()

	state := NewRuntimeState()
	state.UpdateFacts(map[string]interface{}{
		"hostname": "node-1",
	})
	state.UpdateInventory(map[string]interface{}{
		"services":   []interface{}{"svc-a"},
		"containers": []interface{}{"ctr-a"},
	})
	executor := NewExecutor(state, TelemetryHooks{
		GetConfig: func() TelemetryConfig {
			return TelemetryConfig{HeartbeatSec: 15, FactsSec: 60, InventorySec: 60}
		},
		SetConfig: func(patch TelemetryConfigPatch) (TelemetryConfig, error) {
			return TelemetryConfig{HeartbeatSec: 20, FactsSec: 60, InventorySec: 60}, nil
		},
		RequestRefresh: func(reason string) bool {
			return true
		},
	})
	ctx := context.Background()

	cases := []struct {
		name string
		args map[string]interface{}
	}{
		{name: "host.status", args: map[string]interface{}{}},
		{name: "services.list", args: map[string]interface{}{}},
		{name: "containers.list", args: map[string]interface{}{}},
		{name: "agent.telemetry.get_config", args: map[string]interface{}{}},
		{name: "agent.telemetry.set_config", args: map[string]interface{}{"confirm": true, "heartbeatSec": 20}},
		{name: "agent.telemetry.refresh_now", args: map[string]interface{}{"confirm": true}},
		{name: "logs.tail", args: map[string]interface{}{"source": "file", "ref": "/tmp/does-not-exist.log", "lines": 1}},
		{name: "network.ping", args: map[string]interface{}{"target": "127.0.0.1", "count": 1}},
		{name: "network.traceroute", args: map[string]interface{}{"target": "127.0.0.1", "maxHops": 1}},
		{name: "storage.df", args: map[string]interface{}{}},
		{name: "services.restart", args: map[string]interface{}{"name": "ssh.service"}},
		{name: "containers.restart", args: map[string]interface{}{"id": "container-1"}},
		{name: "compose.redeploy", args: map[string]interface{}{"project": "proj-1"}},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			_, err := executor.CallTool(ctx, testCase.name, testCase.args)
			if err != nil {
				t.Fatalf("CallTool(%s) failed: %v", testCase.name, err)
			}
		})
	}

	_, err := executor.CallTool(ctx, "service.probe", map[string]interface{}{
		"protocol": "http",
		"port":     80,
		"target":   "remote.invalid",
	})
	if err == nil {
		t.Fatal("expected service.probe validation error")
	}

	_, err = executor.CallTool(ctx, "terminal.exec", map[string]interface{}{})
	if err == nil {
		t.Fatal("expected terminal.exec validation error")
	}

	_, err = executor.CallTool(ctx, "host.reboot", map[string]interface{}{"confirm": false})
	if err == nil {
		t.Fatal("expected host.reboot confirm validation error")
	}
}

// TestTelemetryToolHandlers implements test telemetry tool handlers.
func TestTelemetryToolHandlers(t *testing.T) {
	t.Parallel()

	state := NewRuntimeState()
	current := TelemetryConfig{
		HeartbeatSec: 15,
		FactsSec:     60,
		InventorySec: 45,
		MinSec:       5,
		MaxSec:       3600,
		UpdatedAt:    time.Now().UTC().Format(time.RFC3339),
	}
	executor := NewExecutor(state, TelemetryHooks{
		GetConfig: func() TelemetryConfig {
			return current
		},
		SetConfig: func(patch TelemetryConfigPatch) (TelemetryConfig, error) {
			if patch.HeartbeatSec != nil {
				current.HeartbeatSec = *patch.HeartbeatSec
			}
			if patch.FactsSec != nil {
				current.FactsSec = *patch.FactsSec
			}
			if patch.InventorySec != nil {
				current.InventorySec = *patch.InventorySec
			}
			current.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			return current, nil
		},
		RequestRefresh: func(reason string) bool {
			return strings.TrimSpace(reason) != ""
		},
	})

	resp, err := executor.toolTelemetryGetConfig()
	if err != nil {
		t.Fatalf("toolTelemetryGetConfig failed: %v", err)
	}
	if resp["ok"] != true {
		t.Fatalf("unexpected telemetry get response: %+v", resp)
	}

	_, err = executor.toolTelemetrySetConfig(map[string]interface{}{"confirm": false})
	if err == nil || !strings.Contains(err.Error(), "confirm=true") {
		t.Fatalf("expected confirm error, got: %v", err)
	}

	_, err = executor.toolTelemetrySetConfig(map[string]interface{}{"confirm": true})
	if err == nil || !strings.Contains(err.Error(), "at least one") {
		t.Fatalf("expected missing update error, got: %v", err)
	}

	resp, err = executor.toolTelemetrySetConfig(map[string]interface{}{
		"confirm":      true,
		"heartbeatSec": 20,
		"factsSec":     "120",
	})
	if err != nil {
		t.Fatalf("toolTelemetrySetConfig failed: %v", err)
	}
	updated := resp["config"].(map[string]interface{})
	if updated["heartbeatSec"] != 20 || updated["factsSec"] != 120 {
		t.Fatalf("unexpected updated config: %+v", updated)
	}

	resp, err = executor.toolTelemetryRefreshNow(map[string]interface{}{
		"confirm": true,
		"reason":  "manual trigger",
	})
	if err != nil {
		t.Fatalf("toolTelemetryRefreshNow failed: %v", err)
	}
	if resp["queued"] != true {
		t.Fatalf("expected queued refresh: %+v", resp)
	}
}

// TestTerminalCommandValidationPaths implements test terminal command validation paths.
func TestTerminalCommandValidationPaths(t *testing.T) {
	t.Parallel()

	executor := NewExecutor(NewRuntimeState())

	_, err := executor.toolTerminalExec(context.Background(), map[string]interface{}{})
	if err == nil || !strings.Contains(err.Error(), "command is required") {
		t.Fatalf("expected missing command error, got %v", err)
	}

	_, err = executor.toolTerminalExec(context.Background(), map[string]interface{}{
		"command": strings.Repeat("x", 241),
	})
	if err == nil || !strings.Contains(err.Error(), "command too long") {
		t.Fatalf("expected long command error, got %v", err)
	}

	helpResp, err := executor.toolTerminalExec(context.Background(), map[string]interface{}{
		"command": "help",
	})
	if err != nil {
		t.Fatalf("help failed: %v", err)
	}
	if !strings.Contains(helpResp["output"].(string), "Allowed commands") {
		t.Fatalf("unexpected help output: %v", helpResp["output"])
	}

	_, err = executor.toolTerminalExec(context.Background(), map[string]interface{}{
		"command": "unknowncmd",
	})
	if err == nil || !strings.Contains(err.Error(), "command not allowed") {
		t.Fatalf("expected command not allowed error, got %v", err)
	}
}

// TestToolListFilesAndNormalizePath implements test tool list files and normalize path.
func TestToolListFilesAndNormalizePath(t *testing.T) {
	t.Parallel()

	executor := NewExecutor(NewRuntimeState())
	tempDir := t.TempDir()
	allowedDir := filepath.Join("/tmp", filepath.Base(tempDir))
	if err := os.MkdirAll(allowedDir, 0o755); err != nil {
		t.Fatalf("mkdir allowed dir: %v", err)
	}
	defer os.RemoveAll(allowedDir)

	if err := os.WriteFile(filepath.Join(allowedDir, "a.txt"), []byte("a"), 0o600); err != nil {
		t.Fatalf("write temp file: %v", err)
	}
	if err := os.Mkdir(filepath.Join(allowedDir, "subdir"), 0o755); err != nil {
		t.Fatalf("mkdir subdir: %v", err)
	}

	resp, err := executor.toolListFiles(allowedDir)
	if err != nil {
		t.Fatalf("toolListFiles failed: %v", err)
	}
	if resp["ok"] != true {
		t.Fatalf("expected ok response: %+v", resp)
	}
	entries := resp["entries"].([]string)
	if len(entries) == 0 {
		t.Fatalf("expected entries for %s", allowedDir)
	}

	_, err = normalizeLsPath("../etc")
	if err == nil {
		t.Fatal("expected path traversal error")
	}
	_, err = normalizeLsPath("/etc")
	if err == nil {
		t.Fatal("expected allowlist error")
	}
}

// TestSafeReadFileAndSortHelpers implements test safe read file and sort helpers.
func TestSafeReadFileAndSortHelpers(t *testing.T) {
	t.Parallel()

	path := filepath.Join("/tmp", "labagent-safe-read-test.log")
	content := "line1\nline2\nline3\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write safe read test file: %v", err)
	}
	defer os.Remove(path)

	out, err := SafeReadFile(path, 2)
	if err != nil {
		t.Fatalf("SafeReadFile failed: %v", err)
	}
	if !strings.Contains(out, "line3") {
		t.Fatalf("unexpected tailed output: %q", out)
	}

	_, err = SafeReadFile("/etc/passwd", 5)
	if err == nil {
		t.Fatal("expected path not allowed error")
	}

	sorted := SortByTopProcesses([]string{"z", "a", "m"}, 2)
	if got := strings.Join(sorted, ","); got != "a,m" {
		t.Fatalf("unexpected sorted output: %s", got)
	}
}

// TestArgumentParsingHelpers implements test argument parsing helpers.
func TestArgumentParsingHelpers(t *testing.T) {
	t.Parallel()

	args := map[string]interface{}{
		"name":         "  api  ",
		"count":        "3",
		"enabled":      "yes",
		"notBool":      "abc",
		"nested":       map[string]interface{}{"numbers": []interface{}{1.0, "2", "x"}, "words": []interface{}{" a ", "b", ""}},
		"heartbeatSec": "30",
	}

	if got := stringArg(args, "name", "fallback"); got != "api" {
		t.Fatalf("stringArg mismatch: %s", got)
	}
	if got := intArg(args, "count", 9); got != 3 {
		t.Fatalf("intArg mismatch: %d", got)
	}
	if got := boolArg(args, "enabled", false); !got {
		t.Fatalf("boolArg expected true")
	}
	if got := boolArg(args, "notBool", true); !got {
		t.Fatalf("boolArg fallback mismatch")
	}
	if got, ok := intPtrArg(args, "heartbeatSec"); !ok || got != 30 {
		t.Fatalf("intPtrArg mismatch: %d ok=%v", got, ok)
	}

	numbers := intSliceArg(args, "nested.numbers", 10)
	if len(numbers) != 2 || numbers[0] != 1 || numbers[1] != 2 {
		t.Fatalf("intSliceArg mismatch: %+v", numbers)
	}
	words := stringSliceArg(args, "nested.words", 10, 4)
	if len(words) != 2 || words[0] != "a" || words[1] != "b" {
		t.Fatalf("stringSliceArg mismatch: %+v", words)
	}

	if _, ok := nestedArg(args, "nested.missing"); ok {
		t.Fatal("nestedArg expected missing value")
	}
}

// TestServiceProbeValidationAndSuccess implements test service probe validation and success.
func TestServiceProbeValidationAndSuccess(t *testing.T) {
	t.Parallel()

	state := NewRuntimeState()
	state.UpdateFacts(map[string]interface{}{
		"hostname": "node-1",
	})
	executor := NewExecutor(state)

	_, err := executor.toolServiceProbe(context.Background(), map[string]interface{}{
		"protocol": "smtp",
		"port":     80,
	})
	if err == nil || !strings.Contains(err.Error(), "protocol must be one of") {
		t.Fatalf("expected protocol validation error, got %v", err)
	}

	_, err = executor.toolServiceProbe(context.Background(), map[string]interface{}{
		"protocol": "http",
		"port":     80,
		"target":   "not-local",
	})
	if err == nil || !strings.Contains(err.Error(), "target must resolve to the local host") {
		t.Fatalf("expected local target validation error, got %v", err)
	}

	httpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Test", "ok")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("service probe body"))
	}))
	defer httpSrv.Close()
	parsed := strings.TrimPrefix(httpSrv.URL, "http://")
	host, portText, splitErr := net.SplitHostPort(parsed)
	if splitErr != nil {
		t.Fatalf("split host/port: %v", splitErr)
	}

	resp, err := executor.toolServiceProbe(context.Background(), map[string]interface{}{
		"protocol": "http",
		"port":     portText,
		"target":   host,
		"path":     "/",
		"expect": map[string]interface{}{
			"statusCodes":    []interface{}{200.0},
			"bodyContains":   []interface{}{"probe"},
			"headersContain": []interface{}{"x-test"},
		},
	})
	if err != nil {
		t.Fatalf("http probe failed: %v", err)
	}
	if resp["ok"] != true || resp["reachable"] != true {
		t.Fatalf("unexpected probe response: %+v", resp)
	}
}

// TestServiceProbeTCPBranch implements test service probe tcpbranch.
func TestServiceProbeTCPBranch(t *testing.T) {
	t.Parallel()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp: %v", err)
	}
	defer listener.Close()
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr == nil {
			_ = conn.Close()
		}
	}()

	host, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatalf("split host/port: %v", err)
	}
	port := intArg(map[string]interface{}{"p": portText}, "p", 0)
	executor := NewExecutor(NewRuntimeState())
	resp, err := executor.toolServiceProbe(context.Background(), map[string]interface{}{
		"protocol": "tcp",
		"target":   host,
		"port":     port,
	})
	if err != nil {
		t.Fatalf("toolServiceProbe tcp failed: %v", err)
	}
	if resp["reachable"] != true || resp["ok"] != true {
		t.Fatalf("unexpected tcp probe response: %+v", resp)
	}
}

// TestCIDRAndSubnetHelpers implements test cidrand subnet helpers.
func TestCIDRAndSubnetHelpers(t *testing.T) {
	t.Parallel()

	normalized := normalizeCIDRList([]string{"10.0.0.0/24", "10.0.0.0/24", "invalid", " 192.168.1.0/24 "})
	if len(normalized) != 2 {
		t.Fatalf("normalizeCIDRList mismatch: %+v", normalized)
	}

	if !isPrivateIPv4(net.ParseIP("10.0.0.1").To4()) {
		t.Fatal("expected private ipv4 for 10.0.0.1")
	}
	if isPrivateIPv4(net.ParseIP("8.8.8.8").To4()) {
		t.Fatal("did not expect private ipv4 for 8.8.8.8")
	}

	hosts, truncated := enumerateCIDRHosts([]string{"10.0.0.0/30"}, 10)
	if truncated || len(hosts) != 2 {
		t.Fatalf("unexpected host enumeration: hosts=%v truncated=%v", hosts, truncated)
	}

	value := ipv4ToUint32(net.ParseIP("192.168.1.10"))
	if got := uint32ToIPv4(value).String(); got != "192.168.1.10" {
		t.Fatalf("ipv4 conversion mismatch: %s", got)
	}
}

// TestParseSignaturesAndBuildTargets implements test parse signatures and build targets.
func TestParseSignaturesAndBuildTargets(t *testing.T) {
	t.Parallel()

	signatures := parseSubnetScanSignatures([]interface{}{
		map[string]interface{}{
			"id":   "svc-http",
			"name": "HTTP service",
			"tags": []interface{}{"web"},
			"probes": []interface{}{
				map[string]interface{}{
					"protocol":    "http",
					"ports":       []interface{}{8080.0},
					"path":        "health",
					"statusCodes": []interface{}{200.0},
				},
			},
		},
		map[string]interface{}{
			"id": "invalid-without-name",
		},
	})
	if len(signatures) != 1 {
		t.Fatalf("expected one valid signature, got %+v", signatures)
	}
	if signatures[0].Probes[0].Path != "/health" {
		t.Fatalf("expected normalized probe path, got %s", signatures[0].Probes[0].Path)
	}

	targets := buildSubnetScanTargets(signatures, true)
	if len(targets) < 2 {
		t.Fatalf("expected signature target + common web targets, got %d", len(targets))
	}
}

// TestExecuteSubnetProbeHTTPAndTCP implements test execute subnet probe httpand tcp.
func TestExecuteSubnetProbeHTTPAndTCP(t *testing.T) {
	t.Parallel()

	httpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-App", "agent")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("healthy"))
	}))
	defer httpSrv.Close()
	parsed := strings.TrimPrefix(httpSrv.URL, "http://")
	host, portText, err := net.SplitHostPort(parsed)
	if err != nil {
		t.Fatalf("split host/port: %v", err)
	}
	port := intArg(map[string]interface{}{"p": portText}, "p", 0)
	result := executeSubnetProbe(context.Background(), host, subnetScanProbe{
		Protocol:       "http",
		Port:           port,
		Path:           "/",
		StatusCodes:    []int{200},
		BodyContains:   []string{"healthy"},
		HeadersContain: []string{"x-app"},
	}, 2000)
	if !result.reachable || !result.matched || result.statusCode != 200 {
		t.Fatalf("unexpected http probe result: %+v", result)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp: %v", err)
	}
	defer listener.Close()
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr == nil {
			_ = conn.Close()
		}
	}()
	tcpAddr := listener.Addr().String()
	tcpHost, tcpPortText, err := net.SplitHostPort(tcpAddr)
	if err != nil {
		t.Fatalf("split tcp host/port: %v", err)
	}
	tcpPort := intArg(map[string]interface{}{"p": tcpPortText}, "p", 0)
	tcpResult := executeSubnetProbe(context.Background(), tcpHost, subnetScanProbe{
		Protocol: "tcp",
		Port:     tcpPort,
	}, 2000)
	if !tcpResult.reachable || !tcpResult.matched {
		t.Fatalf("unexpected tcp probe result: %+v", tcpResult)
	}
}

// TestToolNetworkScanKnownServicesShortCircuits implements test tool network scan known services short circuits.
func TestToolNetworkScanKnownServicesShortCircuits(t *testing.T) {
	t.Parallel()

	executor := NewExecutor(NewRuntimeState())

	resp, err := executor.toolNetworkScanKnownServices(context.Background(), map[string]interface{}{
		"cidrs": []interface{}{},
	})
	if err != nil {
		t.Fatalf("scan known services failed: %v", err)
	}
	if resp["hostsScanned"] != 0 {
		t.Fatalf("expected zero hosts scanned, got %+v", resp)
	}
	warnings, ok := resp["warnings"].([]string)
	if !ok || len(warnings) == 0 {
		t.Fatalf("expected warnings in empty CIDR response: %+v", resp)
	}
}

// TestToolNetworkScanKnownServicesEndToEndTCP implements test tool network scan known services end to end tcp.
func TestToolNetworkScanKnownServicesEndToEndTCP(t *testing.T) {
	t.Parallel()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp: %v", err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	_, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatalf("split listener addr: %v", err)
	}

	executor := NewExecutor(NewRuntimeState())
	resp, err := executor.toolNetworkScanKnownServices(context.Background(), map[string]interface{}{
		"cidrs":                 []interface{}{"127.0.0.1/32"},
		"includeCommonWebPorts": false,
		"concurrency":           1,
		"maxHosts":              8,
		"signatures": []interface{}{
			map[string]interface{}{
				"id":   "ssh",
				"name": "SSH",
				"probes": []interface{}{
					map[string]interface{}{
						"protocol": "tcp",
						"ports":    []interface{}{portText},
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("toolNetworkScanKnownServices failed: %v", err)
	}
	if resp["hostsScanned"].(int) < 1 {
		t.Fatalf("expected at least one scanned host: %+v", resp)
	}
	if resp["hostsReachable"].(int) < 1 {
		t.Fatalf("expected reachable host: %+v", resp)
	}
	detections := resp["detections"].([]map[string]interface{})
	if len(detections) < 1 {
		t.Fatalf("expected detections in scan result: %+v", resp)
	}
}

// TestToolNetworkScanKnownServicesInterrupted implements test tool network scan known services interrupted.
func TestToolNetworkScanKnownServicesInterrupted(t *testing.T) {
	t.Parallel()

	executor := NewExecutor(NewRuntimeState())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	resp, err := executor.toolNetworkScanKnownServices(ctx, map[string]interface{}{
		"cidrs":       []interface{}{"127.0.0.1/24"},
		"concurrency": 1,
		"maxHosts":    16,
		"signatures": []interface{}{
			map[string]interface{}{
				"id":   "tcp",
				"name": "TCP",
				"probes": []interface{}{
					map[string]interface{}{
						"protocol": "tcp",
						"ports":    []interface{}{80.0},
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("toolNetworkScanKnownServices interrupted failed: %v", err)
	}
	warnings := resp["warnings"].([]string)
	if len(warnings) == 0 {
		t.Fatalf("expected interruption warning: %+v", resp)
	}
}

// TestToolNetworkScanKnownServicesNoTargets implements test tool network scan known services no targets.
func TestToolNetworkScanKnownServicesNoTargets(t *testing.T) {
	t.Parallel()

	executor := NewExecutor(NewRuntimeState())
	resp, err := executor.toolNetworkScanKnownServices(context.Background(), map[string]interface{}{
		"cidrs":                 []interface{}{"127.0.0.1/32"},
		"includeCommonWebPorts": false,
		"signatures":            []interface{}{},
	})
	if err != nil {
		t.Fatalf("toolNetworkScanKnownServices no targets failed: %v", err)
	}
	if resp["hostsScanned"] != 0 {
		t.Fatalf("expected zero hosts scanned when no targets configured: %+v", resp)
	}
}

// TestToolNetworkScanKnownServicesAsyncLifecycle implements test tool network scan known services async lifecycle.
func TestToolNetworkScanKnownServicesAsyncLifecycle(t *testing.T) {
	t.Parallel()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp: %v", err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	_, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatalf("split listener addr: %v", err)
	}

	executor := NewExecutor(NewRuntimeState())
	started, err := executor.toolNetworkScanKnownServicesStart(map[string]interface{}{
		"cidrs":                 []interface{}{"127.0.0.1/32"},
		"includeCommonWebPorts": false,
		"concurrency":           1,
		"maxHosts":              8,
		"toolCallTimeoutMs":     5000,
		"signatures": []interface{}{
			map[string]interface{}{
				"id":   "ssh",
				"name": "SSH",
				"probes": []interface{}{
					map[string]interface{}{
						"protocol": "tcp",
						"ports":    []interface{}{portText},
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("toolNetworkScanKnownServicesStart failed: %v", err)
	}

	jobID, ok := started["jobId"].(string)
	if !ok || strings.TrimSpace(jobID) == "" {
		t.Fatalf("expected job id in start response: %+v", started)
	}
	waitForSubnetScanJobState(t, executor, jobID, string(subnetScanJobStateCompleted))

	resultResp, err := executor.toolNetworkScanKnownServicesResult(map[string]interface{}{
		"jobId": jobID,
	})
	if err != nil {
		t.Fatalf("toolNetworkScanKnownServicesResult failed: %v", err)
	}
	if resultResp["jobId"] != jobID {
		t.Fatalf("unexpected job id in result response: %+v", resultResp)
	}
	rawResult, ok := resultResp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected nested result payload: %+v", resultResp)
	}
	if rawResult["hostsReachable"].(int) < 1 {
		t.Fatalf("expected reachable host in async result: %+v", rawResult)
	}
	detections := rawResult["detections"].([]map[string]interface{})
	if len(detections) < 1 {
		t.Fatalf("expected detections in async result: %+v", rawResult)
	}
	if _, err := executor.toolNetworkScanKnownServicesStatus(map[string]interface{}{"jobId": jobID}); err == nil {
		t.Fatal("expected async subnet job to be removed after result retrieval")
	}
}

// TestToolNetworkScanKnownServicesAsyncRejectsConcurrentStart implements test tool network scan known services async rejects concurrent start.
func TestToolNetworkScanKnownServicesAsyncRejectsConcurrentStart(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(250 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("slow-ok"))
	}))
	defer server.Close()

	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse test server url: %v", err)
	}
	host, portText, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatalf("split test server host/port: %v", err)
	}

	executor := NewExecutor(NewRuntimeState())
	args := map[string]interface{}{
		"cidrs":                 []interface{}{host + "/32"},
		"includeCommonWebPorts": false,
		"concurrency":           1,
		"maxHosts":              1,
		"connectTimeoutMs":      1000,
		"toolCallTimeoutMs":     5000,
		"signatures": []interface{}{
			map[string]interface{}{
				"id":   "slow-http",
				"name": "Slow HTTP",
				"probes": []interface{}{
					map[string]interface{}{
						"protocol":    "http",
						"ports":       []interface{}{portText},
						"statusCodes": []interface{}{200},
						"path":        "/",
					},
				},
			},
		},
	}

	started, err := executor.toolNetworkScanKnownServicesStart(args)
	if err != nil {
		t.Fatalf("first async subnet scan start failed: %v", err)
	}
	jobID := started["jobId"].(string)

	_, err = executor.toolNetworkScanKnownServicesStart(args)
	if err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("expected concurrent async scan rejection, got: %v", err)
	}

	waitForSubnetScanJobState(t, executor, jobID, string(subnetScanJobStateCompleted))
}

// waitForSubnetScanJobState implements wait for subnet scan job state.
func waitForSubnetScanJobState(t *testing.T, executor *Executor, jobID string, expectedState string) map[string]interface{} {
	t.Helper()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		status, err := executor.toolNetworkScanKnownServicesStatus(map[string]interface{}{
			"jobId": jobID,
		})
		if err != nil {
			t.Fatalf("toolNetworkScanKnownServicesStatus failed: %v", err)
		}
		if status["state"] == expectedState {
			return status
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for subnet scan job %s to reach %s", jobID, expectedState)
	return nil
}

// TestDiscoverLocalPrivateCIDRs implements test discover local private cidrs.
func TestDiscoverLocalPrivateCIDRs(t *testing.T) {
	t.Parallel()

	cidrs, err := discoverLocalPrivateCIDRs()
	if err != nil {
		t.Fatalf("discoverLocalPrivateCIDRs failed: %v", err)
	}
	if len(cidrs) > 128 {
		t.Fatalf("expected capped CIDR list, got %d entries", len(cidrs))
	}
}

// TestValidationBranchesForWriteTools implements test validation branches for write tools.
func TestValidationBranchesForWriteTools(t *testing.T) {
	t.Parallel()

	executor := NewExecutor(NewRuntimeState())

	if _, err := executor.toolServiceRestart(context.Background(), map[string]interface{}{"name": "bad name"}); err == nil {
		t.Fatal("expected invalid service name error")
	}
	if _, err := executor.toolContainerRestart(context.Background(), map[string]interface{}{"id": "bad id!"}); err == nil {
		t.Fatal("expected invalid container id error")
	}
	if _, err := executor.toolComposeRedeploy(context.Background(), map[string]interface{}{"project": "bad project!"}); err == nil {
		t.Fatal("expected invalid compose project error")
	}
	if _, err := executor.toolHostReboot(context.Background(), map[string]interface{}{"confirm": false}); err == nil {
		t.Fatal("expected confirm=true error")
	}
}

// TestCommandBackedToolsExecutionPaths implements test command backed tools execution paths.
func TestCommandBackedToolsExecutionPaths(t *testing.T) {
	t.Parallel()

	executor := NewExecutor(NewRuntimeState())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	df, err := executor.toolStorageDF(ctx)
	if err != nil {
		t.Fatalf("toolStorageDF failed: %v", err)
	}
	if _, ok := df["ok"]; !ok {
		t.Fatalf("expected ok flag in storage response: %+v", df)
	}

	pingResp, err := executor.toolNetworkPing(ctx, map[string]interface{}{"target": "127.0.0.1", "count": 1})
	if err != nil {
		t.Fatalf("toolNetworkPing failed: %v", err)
	}
	if pingResp["target"] != "127.0.0.1" {
		t.Fatalf("unexpected ping response: %+v", pingResp)
	}

	traceResp, err := executor.toolNetworkTraceroute(ctx, map[string]interface{}{"target": "127.0.0.1", "maxHops": 1})
	if err != nil {
		t.Fatalf("toolNetworkTraceroute failed: %v", err)
	}
	if traceResp["target"] != "127.0.0.1" {
		t.Fatalf("unexpected traceroute response: %+v", traceResp)
	}

	logPath := filepath.Join("/tmp", "labagent-logs-tail.txt")
	if err := os.WriteFile(logPath, []byte("alpha\nbeta\ngamma\n"), 0o600); err != nil {
		t.Fatalf("write temp log file: %v", err)
	}
	defer os.Remove(logPath)
	logsResp, err := executor.toolLogsTail(ctx, map[string]interface{}{
		"source": "file",
		"ref":    logPath,
		"lines":  2,
	})
	if err != nil {
		t.Fatalf("toolLogsTail file source failed: %v", err)
	}
	if logsResp["source"] != "file" {
		t.Fatalf("unexpected logs response: %+v", logsResp)
	}

	serviceResp, err := executor.toolServiceRestart(ctx, map[string]interface{}{"name": "ssh.service"})
	if err != nil {
		t.Fatalf("toolServiceRestart valid input failed: %v", err)
	}
	if _, ok := serviceResp["ok"]; !ok {
		t.Fatalf("expected ok key in service restart response: %+v", serviceResp)
	}

	containerResp, err := executor.toolContainerRestart(ctx, map[string]interface{}{"id": "container-1"})
	if err != nil {
		t.Fatalf("toolContainerRestart valid input failed: %v", err)
	}
	if _, ok := containerResp["ok"]; !ok {
		t.Fatalf("expected ok key in container restart response: %+v", containerResp)
	}

	composeResp, err := executor.toolComposeRedeploy(ctx, map[string]interface{}{"project": "project-1"})
	if err != nil {
		t.Fatalf("toolComposeRedeploy valid input failed: %v", err)
	}
	if _, ok := composeResp["ok"]; !ok {
		t.Fatalf("expected ok key in compose redeploy response: %+v", composeResp)
	}

	rebootResp, err := executor.toolHostReboot(ctx, map[string]interface{}{"confirm": true})
	if err != nil {
		t.Fatalf("toolHostReboot confirm path failed: %v", err)
	}
	if _, ok := rebootResp["ok"]; !ok {
		t.Fatalf("expected ok key in reboot response: %+v", rebootResp)
	}
}

// TestTerminalExecRoutesSubcommands implements test terminal exec routes subcommands.
func TestTerminalExecRoutesSubcommands(t *testing.T) {
	t.Parallel()

	state := NewRuntimeState()
	state.UpdateFacts(map[string]interface{}{"hostname": "node-x"})
	state.UpdateInventory(map[string]interface{}{"services": []interface{}{"svc-x"}, "containers": []interface{}{"ctr-x"}})
	executor := NewExecutor(state)
	ctx := context.Background()

	for _, command := range []string{"status", "services", "containers", "df", "ls /tmp", "ping 127.0.0.1 1", "traceroute 127.0.0.1 1"} {
		resp, err := executor.toolTerminalExec(ctx, map[string]interface{}{"command": command})
		if err != nil {
			t.Fatalf("terminal command %q failed: %v", command, err)
		}
		if resp["command"] != command {
			t.Fatalf("expected command echo for %q, got %+v", command, resp)
		}
	}

	logsResp, err := executor.toolTerminalExec(ctx, map[string]interface{}{"command": "logs ssh 10"})
	if err != nil {
		t.Fatalf("terminal logs command failed: %v", err)
	}
	if logsResp["command"] != "logs ssh 10" {
		t.Fatalf("unexpected logs command response: %+v", logsResp)
	}
}

// TestTerminalExecArgumentErrors implements test terminal exec argument errors.
func TestTerminalExecArgumentErrors(t *testing.T) {
	t.Parallel()

	executor := NewExecutor(NewRuntimeState())
	ctx := context.Background()
	_, err := executor.toolTerminalExec(ctx, map[string]interface{}{"command": "ping"})
	if err == nil {
		t.Fatal("expected ping usage error")
	}
	_, err = executor.toolTerminalExec(ctx, map[string]interface{}{"command": "ping 127.0.0.1 nope"})
	if err == nil {
		t.Fatal("expected ping numeric parse error")
	}
	_, err = executor.toolTerminalExec(ctx, map[string]interface{}{"command": "traceroute"})
	if err == nil {
		t.Fatal("expected traceroute usage error")
	}
	_, err = executor.toolTerminalExec(ctx, map[string]interface{}{"command": "traceroute 127.0.0.1 nope"})
	if err == nil {
		t.Fatal("expected traceroute numeric parse error")
	}
	_, err = executor.toolTerminalExec(ctx, map[string]interface{}{"command": "logs"})
	if err == nil {
		t.Fatal("expected logs usage error")
	}
	_, err = executor.toolTerminalExec(ctx, map[string]interface{}{"command": "logs ssh nope"})
	if err == nil {
		t.Fatal("expected logs numeric parse error")
	}
}

// TestMarshalPrettyAndRunCommandCapture implements test marshal pretty and run command capture.
func TestMarshalPrettyAndRunCommandCapture(t *testing.T) {
	t.Parallel()

	output := marshalPretty(map[string]interface{}{"ok": true})
	if !strings.Contains(output, "\"ok\": true") {
		t.Fatalf("unexpected pretty json output: %s", output)
	}

	cmd := execCommandForTest("sh", "-c", "printf 'out'; printf 'err' 1>&2")
	stdout, stderr, err := runCommandCapture(cmd)
	if err != nil {
		t.Fatalf("runCommandCapture failed: %v", err)
	}
	if stdout != "out" || stderr != "err" {
		t.Fatalf("unexpected command capture stdout=%q stderr=%q", stdout, stderr)
	}
}

// TestTelemetryHooksUnavailableErrors implements test telemetry hooks unavailable errors.
func TestTelemetryHooksUnavailableErrors(t *testing.T) {
	t.Parallel()

	executor := NewExecutor(NewRuntimeState())
	if _, err := executor.toolTelemetryGetConfig(); err == nil {
		t.Fatal("expected telemetry get config unavailable error")
	}
	if _, err := executor.toolTelemetrySetConfig(map[string]interface{}{"confirm": true, "heartbeatSec": 20}); err == nil {
		t.Fatal("expected telemetry set config unavailable error")
	}
	if _, err := executor.toolTelemetryRefreshNow(map[string]interface{}{"confirm": true}); err == nil {
		t.Fatal("expected telemetry refresh unavailable error")
	}
}

// TestIsAllowedLocalTargetFromFactsAndInventory implements test is allowed local target from facts and inventory.
func TestIsAllowedLocalTargetFromFactsAndInventory(t *testing.T) {
	t.Parallel()

	state := NewRuntimeState()
	state.UpdateFacts(map[string]interface{}{
		"hostname": "node-a",
		"snapshot": map[string]interface{}{
			"network": map[string]interface{}{
				"primaryIp": "10.0.0.5",
				"interfaces": []interface{}{
					map[string]interface{}{"ipv4": "10.0.0.6"},
				},
			},
		},
	})
	state.UpdateInventory(map[string]interface{}{"hostname": "inventory-host"})
	executor := NewExecutor(state)

	for _, target := range []string{"localhost", "127.0.0.1", "::1", "node-a", "10.0.0.5", "10.0.0.6", "inventory-host"} {
		if !executor.isAllowedLocalTarget(target) {
			t.Fatalf("expected target %q to be allowed", target)
		}
	}
	if executor.isAllowedLocalTarget("remote-host") {
		t.Fatal("expected remote target to be denied")
	}
}

// TestFlattenHeaderMap implements test flatten header map.
func TestFlattenHeaderMap(t *testing.T) {
	t.Parallel()

	headers := http.Header{
		"X-A": []string{"1", "2"},
		"X-B": []string{"value"},
	}
	flattened := flattenHeaderMap(headers)
	if !strings.Contains(flattened, "X-A:1,2") || !strings.Contains(flattened, "X-B:value") {
		t.Fatalf("unexpected flattened headers: %q", flattened)
	}
}

// TestToolLogsTailValidation implements test tool logs tail validation.
func TestToolLogsTailValidation(t *testing.T) {
	t.Parallel()

	executor := NewExecutor(NewRuntimeState())
	if _, err := executor.toolLogsTail(context.Background(), map[string]interface{}{
		"source": "journalctl",
	}); err == nil {
		t.Fatal("expected journalctl ref validation error")
	}
	if _, err := executor.toolLogsTail(context.Background(), map[string]interface{}{
		"source": "file",
		"ref":    "/etc/passwd",
	}); err == nil {
		t.Fatal("expected file allowlist error")
	}
	if _, err := executor.toolLogsTail(context.Background(), map[string]interface{}{
		"source": "unknown",
	}); err == nil {
		t.Fatal("expected unsupported source error")
	}
}

// TestToolProcessSnapshotAndHostStatus implements test tool process snapshot and host status.
func TestToolProcessSnapshotAndHostStatus(t *testing.T) {
	t.Parallel()

	state := NewRuntimeState()
	state.UpdateFacts(map[string]interface{}{"hostname": "node-z", "cpuPct": 5.5, "memPct": 10.0, "diskPct": 20.0})
	state.UpdateInventory(map[string]interface{}{"services": []interface{}{"svc"}})
	executor := NewExecutor(state)

	status := executor.toolHostStatus()
	if status["hostname"] != "node-z" {
		t.Fatalf("unexpected host status: %+v", status)
	}

	resp, err := executor.toolProcessSnapshot(context.Background(), map[string]interface{}{"limit": 2})
	if err != nil {
		t.Fatalf("toolProcessSnapshot failed: %v", err)
	}
	if _, ok := resp["processes"]; !ok {
		t.Fatalf("expected processes in snapshot: %+v", resp)
	}
}

// TestNetworkToolValidationErrors implements test network tool validation errors.
func TestNetworkToolValidationErrors(t *testing.T) {
	t.Parallel()

	executor := NewExecutor(NewRuntimeState())
	if _, err := executor.toolNetworkPing(context.Background(), map[string]interface{}{}); err == nil {
		t.Fatal("expected ping target validation error")
	}
	if _, err := executor.toolNetworkTraceroute(context.Background(), map[string]interface{}{}); err == nil {
		t.Fatal("expected traceroute target validation error")
	}
}

// TestJSONMarshalabilityOfToolResponses implements test jsonmarshalability of tool responses.
func TestJSONMarshalabilityOfToolResponses(t *testing.T) {
	t.Parallel()

	executor := NewExecutor(NewRuntimeState())
	resp, err := executor.CallTool(context.Background(), "host.status", map[string]interface{}{})
	if err != nil {
		t.Fatalf("CallTool host.status failed: %v", err)
	}
	if _, marshalErr := json.Marshal(resp); marshalErr != nil {
		t.Fatalf("host.status response should be JSON serializable: %v", marshalErr)
	}
}

// TestTelemetrySetConfigErrorPropagation implements test telemetry set config error propagation.
func TestTelemetrySetConfigErrorPropagation(t *testing.T) {
	t.Parallel()

	expectedErr := errors.New("bad config")
	executor := NewExecutor(NewRuntimeState(), TelemetryHooks{
		SetConfig: func(patch TelemetryConfigPatch) (TelemetryConfig, error) {
			return TelemetryConfig{}, expectedErr
		},
	})

	_, err := executor.toolTelemetrySetConfig(map[string]interface{}{
		"confirm":      true,
		"heartbeatSec": 20,
	})
	if err == nil || !strings.Contains(err.Error(), expectedErr.Error()) {
		t.Fatalf("expected propagated config error, got %v", err)
	}
}

// execCommandForTest implements exec command for test.
func execCommandForTest(name string, args ...string) *exec.Cmd {
	return exec.Command(name, args...)
}
