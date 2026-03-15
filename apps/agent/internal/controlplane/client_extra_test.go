// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements client extra test behavior for the lab agent.
package controlplane

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestInventoryAndEventsPostJSON implements test inventory and events post json.
func TestInventoryAndEventsPostJSON(t *testing.T) {
	t.Parallel()

	paths := make([]string, 0, 2)
	client := newFakeClient(t, func(r *http.Request) (*http.Response, error) {
		paths = append(paths, r.URL.Path)
		if got := r.Header.Get("Authorization"); got != "Bearer agent-token" {
			t.Fatalf("unexpected auth header: %s", got)
		}
		return jsonResponse(http.StatusNoContent, map[string]any{})
	})

	ctx := context.Background()
	if err := client.Inventory(ctx, "agent-1", "agent-token", map[string]any{"services": []string{"api"}}); err != nil {
		t.Fatalf("Inventory returned error: %v", err)
	}
	if err := client.Events(ctx, "agent-1", "agent-token", map[string]any{"events": []string{"disk"}}); err != nil {
		t.Fatalf("Events returned error: %v", err)
	}

	if len(paths) != 2 {
		t.Fatalf("expected two API calls, got %d", len(paths))
	}
	if paths[0] != "/api/agents/agent-1/inventory" || paths[1] != "/api/agents/agent-1/events" {
		t.Fatalf("unexpected API paths: %+v", paths)
	}
}

// TestNewClientDefaultsAndTrimsBaseURL implements test new client defaults and trims base url.
func TestNewClientDefaultsAndTrimsBaseURL(t *testing.T) {
	t.Parallel()

	client := NewClient("http://control-plane.test/")
	if client.baseURL != "http://control-plane.test" {
		t.Fatalf("unexpected trimmed base URL: %s", client.baseURL)
	}
	if client.httpClient == nil || client.httpClient.Timeout != 15*time.Second {
		t.Fatalf("unexpected default HTTP client: %+v", client.httpClient)
	}

	clientWithNilHTTP := NewClientWithHTTPClient("http://control-plane.test/", nil)
	if clientWithNilHTTP.baseURL != "http://control-plane.test" {
		t.Fatalf("unexpected trimmed base URL with nil client: %s", clientWithNilHTTP.baseURL)
	}
	if clientWithNilHTTP.httpClient == nil || clientWithNilHTTP.httpClient.Timeout != 15*time.Second {
		t.Fatalf("unexpected default HTTP client with nil input: %+v", clientWithNilHTTP.httpClient)
	}
}

// TestParseRequestErrorArrayMessageAndRequestErrorString implements test parse request error array message and request error string.
func TestParseRequestErrorArrayMessageAndRequestErrorString(t *testing.T) {
	t.Parallel()

	err := parseRequestError(http.StatusBadRequest, []byte(`{"statusCode":400,"message":["first",["second"],""],"code":"BAD_REQUEST"}`))
	requestErr, ok := err.(*RequestError)
	if !ok {
		t.Fatalf("expected RequestError, got %T", err)
	}
	if requestErr.Message != "first; second" {
		t.Fatalf("unexpected coerced message: %q", requestErr.Message)
	}
	if requestErr.Error() != "control plane request failed: 400 first; second (BAD_REQUEST)" {
		t.Fatalf("unexpected formatted error: %s", requestErr.Error())
	}

	if got := (&RequestError{StatusCode: http.StatusForbidden, Code: AgentRevokedCode}).Error(); !strings.Contains(got, AgentRevokedCode) {
		t.Fatalf("expected code-only RequestError to include code, got %q", got)
	}
}
