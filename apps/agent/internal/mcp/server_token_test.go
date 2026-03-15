// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements server token test behavior for the lab agent.
package mcp

import (
	"net/http/httptest"
	"testing"
)

// TestSetAgentTokenUpdatesAuthValidation implements test set agent token updates auth validation.
func TestSetAgentTokenUpdatesAuthValidation(t *testing.T) {
	t.Parallel()

	server := newTestServer()
	req := httptest.NewRequest("GET", "/mcp", nil)
	req.Header.Set("Origin", "http://allowed.local")
	req.Header.Set("Authorization", "Bearer agent-token")
	if !server.validateAuth(req) {
		t.Fatal("expected initial token to validate")
	}

	server.SetAgentToken("rotated-token")
	req.Header.Set("Authorization", "Bearer agent-token")
	if server.validateAuth(req) {
		t.Fatal("expected old token to be rejected after rotation")
	}

	req.Header.Set("Authorization", "Bearer rotated-token")
	if !server.validateAuth(req) {
		t.Fatal("expected rotated token to validate")
	}
}
