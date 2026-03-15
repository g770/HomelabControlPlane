// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements server test behavior for the lab agent.
package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"homelab/labagent/internal/tools"
)

// newTestServer implements new test server.
func newTestServer() *Server {
	state := tools.NewRuntimeState()
	state.UpdateFacts(map[string]interface{}{"hostname": "node-1"})
	state.UpdateInventory(map[string]interface{}{"services": []interface{}{"svc-a"}})
	executor := tools.NewExecutor(state)
	return NewServer("127.0.0.1", 0, "agent-token", []string{"http://allowed.local"}, executor)
}

// newRPCRequest implements new rpcrequest.
func newRPCRequest(t *testing.T, method string, params interface{}) []byte {
	t.Helper()
	payload := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      "req-1",
		"method":  method,
		"params":  params,
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal rpc request: %v", err)
	}
	return data
}

// performMCPRequest implements perform mcprequest.
func performMCPRequest(t *testing.T, s *Server, method string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/mcp", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer agent-token")
	req.Header.Set("Origin", "http://allowed.local")
	rec := httptest.NewRecorder()
	s.handleMCP(rec, req)
	return rec
}

// TestParseTimeoutMs implements test parse timeout ms.
func TestParseTimeoutMs(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		raw   interface{}
		value int64
		ok    bool
	}{
		{name: "float", raw: float64(1200), value: 1200, ok: true},
		{name: "int", raw: 42, value: 42, ok: true},
		{name: "int64", raw: int64(99), value: 99, ok: true},
		{name: "string", raw: "5000", value: 5000, ok: true},
		{name: "nan", raw: math.NaN(), value: 0, ok: false},
		{name: "invalid string", raw: "abc", value: 0, ok: false},
		{name: "missing", raw: struct{}{}, value: 0, ok: false},
	}

	for _, testCase := range tests {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			got, ok := parseTimeoutMs(testCase.raw)
			if got != testCase.value || ok != testCase.ok {
				t.Fatalf("parseTimeoutMs(%v) = (%d, %v), expected (%d, %v)", testCase.raw, got, ok, testCase.value, testCase.ok)
			}
		})
	}
}

// TestResolveToolCallTimeout implements test resolve tool call timeout.
func TestResolveToolCallTimeout(t *testing.T) {
	t.Parallel()

	if got := resolveToolCallTimeout("services.list", map[string]interface{}{}); got != defaultRPCTimeout {
		t.Fatalf("expected default timeout for non-subnet tool, got %s", got)
	}

	min := resolveToolCallTimeout("network.scan_known_services", map[string]interface{}{"toolCallTimeoutMs": 100})
	if min != time.Duration(subnetToolCallTimeoutMinMs)*time.Millisecond {
		t.Fatalf("expected min clamped timeout, got %s", min)
	}

	max := resolveToolCallTimeout("network.scan_known_services", map[string]interface{}{"toolCallTimeoutMs": 700000})
	if max != time.Duration(subnetToolCallTimeoutMaxMs)*time.Millisecond {
		t.Fatalf("expected max clamped timeout, got %s", max)
	}
}

// TestPromptContent implements test prompt content.
func TestPromptContent(t *testing.T) {
	t.Parallel()

	if !strings.Contains(promptContent("Diagnose high CPU"), "host.status") {
		t.Fatal("expected known prompt content")
	}
	if promptContent("unknown") != "Prompt not found" {
		t.Fatal("expected prompt not found fallback")
	}
}

// TestValidateOriginAndAuth implements test validate origin and auth.
func TestValidateOriginAndAuth(t *testing.T) {
	t.Parallel()

	s := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("Origin", "http://allowed.local")
	if !s.validateOrigin(req) {
		t.Fatal("expected allowed origin")
	}
	req.Header.Set("Origin", "http://blocked.local")
	if s.validateOrigin(req) {
		t.Fatal("expected blocked origin")
	}

	req.Header.Set("Authorization", "Bearer agent-token")
	if !s.validateAuth(req) {
		t.Fatal("expected valid auth")
	}
	req.Header.Set("Authorization", "Bearer wrong")
	if s.validateAuth(req) {
		t.Fatal("expected invalid auth for wrong token")
	}
	req.Header.Del("Authorization")
	if s.validateAuth(req) {
		t.Fatal("expected invalid auth for missing header")
	}
}

// TestHandleMCPAuthOriginAndMethodValidation implements test handle mcpauth origin and method validation.
func TestHandleMCPAuthOriginAndMethodValidation(t *testing.T) {
	t.Parallel()

	s := newTestServer()

	noAuthReq := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	noAuthReq.Header.Set("Origin", "http://allowed.local")
	noAuthRec := httptest.NewRecorder()
	s.handleMCP(noAuthRec, noAuthReq)
	if noAuthRec.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized, got %d", noAuthRec.Code)
	}

	badOriginReq := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	badOriginReq.Header.Set("Authorization", "Bearer agent-token")
	badOriginReq.Header.Set("Origin", "http://blocked.local")
	badOriginRec := httptest.NewRecorder()
	s.handleMCP(badOriginRec, badOriginReq)
	if badOriginRec.Code != http.StatusForbidden {
		t.Fatalf("expected forbidden, got %d", badOriginRec.Code)
	}

	putReq := httptest.NewRequest(http.MethodPut, "/mcp", nil)
	putReq.Header.Set("Authorization", "Bearer agent-token")
	putReq.Header.Set("Origin", "http://allowed.local")
	putRec := httptest.NewRecorder()
	s.handleMCP(putRec, putReq)
	if putRec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected method not allowed, got %d", putRec.Code)
	}
}

// TestHandleMCPGET implements test handle mcpget.
func TestHandleMCPGET(t *testing.T) {
	t.Parallel()

	s := newTestServer()
	req := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer agent-token")
	req.Header.Set("Origin", "http://allowed.local")
	rec := httptest.NewRecorder()
	s.handleMCP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal get response: %v", err)
	}
	if payload["name"] != "labagent-mcp" {
		t.Fatalf("unexpected get payload: %+v", payload)
	}
}

// TestHandleMCPInvalidJSON implements test handle mcpinvalid json.
func TestHandleMCPInvalidJSON(t *testing.T) {
	t.Parallel()

	s := newTestServer()
	rec := performMCPRequest(t, s, http.MethodPost, []byte("{invalid"))

	var payload rpcResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal invalid json response: %v", err)
	}
	if payload.Error == nil || payload.Error.Code != -32700 {
		t.Fatalf("expected parse error response, got %+v", payload)
	}
}

// TestHandleMCPInitializeAndLists implements test handle mcpinitialize and lists.
func TestHandleMCPInitializeAndLists(t *testing.T) {
	t.Parallel()

	s := newTestServer()

	initRec := performMCPRequest(t, s, http.MethodPost, newRPCRequest(t, "initialize", map[string]interface{}{}))
	if initRec.Code != http.StatusOK {
		t.Fatalf("initialize expected 200, got %d", initRec.Code)
	}

	resourcesRec := performMCPRequest(t, s, http.MethodPost, newRPCRequest(t, "resources/list", map[string]interface{}{}))
	toolsRec := performMCPRequest(t, s, http.MethodPost, newRPCRequest(t, "tools/list", map[string]interface{}{}))
	promptsRec := performMCPRequest(t, s, http.MethodPost, newRPCRequest(t, "prompts/list", map[string]interface{}{}))

	for _, rec := range []*httptest.ResponseRecorder{resourcesRec, toolsRec, promptsRec} {
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 from list call, got %d", rec.Code)
		}
	}
}

// TestHandleMCPResourceReadAndToolErrors implements test handle mcpresource read and tool errors.
func TestHandleMCPResourceReadAndToolErrors(t *testing.T) {
	t.Parallel()

	s := newTestServer()

	readErrRec := performMCPRequest(t, s, http.MethodPost, newRPCRequest(t, "resources/read", map[string]interface{}{
		"uri": "host://missing",
	}))
	var readErrResp rpcResponse
	if err := json.Unmarshal(readErrRec.Body.Bytes(), &readErrResp); err != nil {
		t.Fatalf("unmarshal resources/read response: %v", err)
	}
	if readErrResp.Error == nil || readErrResp.Error.Code != -32000 {
		t.Fatalf("expected resource read error, got %+v", readErrResp)
	}

	toolBadParams := performMCPRequest(t, s, http.MethodPost, newRPCRequest(t, "tools/call", map[string]interface{}{
		"name":      "host.status",
		"arguments": "not-an-object",
	}))
	var badParamsResp rpcResponse
	if err := json.Unmarshal(toolBadParams.Body.Bytes(), &badParamsResp); err != nil {
		t.Fatalf("unmarshal bad params response: %v", err)
	}
	if badParamsResp.Error == nil || badParamsResp.Error.Code != -32602 {
		t.Fatalf("expected invalid params error, got %+v", badParamsResp)
	}

	toolErr := performMCPRequest(t, s, http.MethodPost, newRPCRequest(t, "tools/call", map[string]interface{}{
		"name":      "unknown.tool",
		"arguments": map[string]interface{}{},
	}))
	var toolErrResp rpcResponse
	if err := json.Unmarshal(toolErr.Body.Bytes(), &toolErrResp); err != nil {
		t.Fatalf("unmarshal tool error response: %v", err)
	}
	if toolErrResp.Error == nil || toolErrResp.Error.Code != -32001 {
		t.Fatalf("expected tool execution error, got %+v", toolErrResp)
	}
}

// TestHandleMCPPromptsGetAndUnknownMethod implements test handle mcpprompts get and unknown method.
func TestHandleMCPPromptsGetAndUnknownMethod(t *testing.T) {
	t.Parallel()

	s := newTestServer()

	promptRec := performMCPRequest(t, s, http.MethodPost, newRPCRequest(t, "prompts/get", map[string]interface{}{
		"name": "Diagnose high CPU",
	}))
	if promptRec.Code != http.StatusOK {
		t.Fatalf("expected prompt get 200, got %d", promptRec.Code)
	}

	unknownRec := performMCPRequest(t, s, http.MethodPost, newRPCRequest(t, "unknown.method", map[string]interface{}{}))
	var unknownResp rpcResponse
	if err := json.Unmarshal(unknownRec.Body.Bytes(), &unknownResp); err != nil {
		t.Fatalf("unmarshal unknown response: %v", err)
	}
	if unknownResp.Error == nil || unknownResp.Error.Code != -32601 {
		t.Fatalf("expected method not found error, got %+v", unknownResp)
	}
}

// TestShutdownWithoutStart implements test shutdown without start.
func TestShutdownWithoutStart(t *testing.T) {
	t.Parallel()

	s := newTestServer()
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown without start should succeed: %v", err)
	}
}

// TestStartAndShutdown implements test start and shutdown.
func TestStartAndShutdown(t *testing.T) {
	t.Parallel()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port failed: %v", err)
	}
	_, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		_ = listener.Close()
		t.Fatalf("split reserved addr failed: %v", err)
	}
	_ = listener.Close()

	port := 0
	if _, err := fmt.Sscanf(portText, "%d", &port); err != nil {
		t.Fatalf("parse reserved port failed: %v", err)
	}

	state := tools.NewRuntimeState()
	executor := tools.NewExecutor(state)
	s := NewServer("127.0.0.1", port, "agent-token", []string{"http://allowed.local"}, executor)
	if err := s.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer s.Shutdown(context.Background())

	url := fmt.Sprintf("http://127.0.0.1:%d/mcp", port)
	var resp *http.Response
	for i := 0; i < 40; i++ {
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Authorization", "Bearer agent-token")
		req.Header.Set("Origin", "http://allowed.local")
		resp, err = http.DefaultClient.Do(req)
		if err == nil {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("GET /mcp failed after Start: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from started MCP server, got %d", resp.StatusCode)
	}
}
