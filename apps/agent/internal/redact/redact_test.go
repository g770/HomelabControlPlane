// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements redact test behavior for the lab agent.
package redact

import "testing"

// TestRedactString implements test redact string.
func TestRedactString(t *testing.T) {
	input := "Authorization: Bearer abc123\nAPI_KEY=my-secret-value\nnormal line"
	output, redacted := RedactString(input)
	if !redacted {
		t.Fatalf("expected redacted=true")
	}
	if output == input {
		t.Fatalf("expected output to change")
	}
	if output == "" {
		t.Fatalf("expected output not empty")
	}
}
