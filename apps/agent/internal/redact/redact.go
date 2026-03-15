// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements redact behavior for the lab agent.
package redact

import (
	"regexp"
	"strings"
)

var patterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)bearer\s+[a-z0-9\-\._~\+\/=]+`),
	regexp.MustCompile(`(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*['\"]?[a-z0-9\-\._~\+\/=]{6,}`),
	regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`),
	regexp.MustCompile(`(?i)(aws_access_key_id|aws_secret_access_key|kubeconfig|\.env)\s*[:=]\s*[^\s]+`),
}

var envVarPattern = regexp.MustCompile(`(?i)\b([A-Z0-9_]*(TOKEN|SECRET|PASSWORD|KEY)[A-Z0-9_]*)=([^\s]+)`)

// RedactString implements redact string.
func RedactString(input string) (string, bool) {
	redacted := input
	wasRedacted := false

	for _, pattern := range patterns {
		updated := pattern.ReplaceAllString(redacted, "[REDACTED]")
		if updated != redacted {
			wasRedacted = true
			redacted = updated
		}
	}

	updated := envVarPattern.ReplaceAllString(redacted, "$1=[REDACTED]")
	if updated != redacted {
		wasRedacted = true
		redacted = updated
	}

	if strings.Contains(strings.ToLower(redacted), "authorization:") {
		lines := strings.Split(redacted, "\n")
		for i, line := range lines {
			if strings.Contains(strings.ToLower(line), "authorization:") {
				lines[i] = "Authorization: [REDACTED]"
				wasRedacted = true
			}
		}
		redacted = strings.Join(lines, "\n")
	}

	return redacted, wasRedacted
}
