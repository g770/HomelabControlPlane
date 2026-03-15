<!--
Copyright (c) 2026 Homelab Control Plane contributors
SPDX-License-Identifier: MIT

This document captures security expectations and disclosure guidance for the project.
-->

# Security Model

Last verified: 2026-03-13

## Threat Model

The control plane manages infrastructure actions and credentials. Primary threats are token theft, privilege escalation, tool misuse, secret exfiltration, and replay of agent/control traffic.

## Core Controls

- User-facing API routes require JWT auth except explicitly public bootstrap/login flows.
- Agent ingest routes are protected by agent bearer token validation.
- The dashboard authenticates a single built-in local admin account; there is no user-managed RBAC surface.
- Write tools require explicit approval records before execution.
- Every tool execution writes append-only audit events with actor, target, params digest, result, and timestamp.
- Agent MCP endpoint requires bearer auth and validates `Origin` when present.
- Agent redacts sensitive data from logs and diagnostics by default.
- Integration credentials are encrypted at rest using `APP_MASTER_KEY` AES-256-GCM.
- Sensitive reads are redacted by default and require explicit reveal action in UI.

## Secrets Handling

- Never log plaintext secrets.
- Enrollment tokens and agent tokens are stored as hashes.
- Integration credentials are encrypted before persistence.
- `.env` templates never include production secrets.

## Approval Guarantees

- Read-only tools execute directly for the authenticated admin session.
- Write tools (`agent.telemetry.set_config`, `agent.telemetry.refresh_now`, `services.restart`, `containers.restart`, `compose.redeploy`, `host.reboot`) require:
  1. Proposal creation
  2. Explicit user approval API call
  3. Audit log write
  4. Execution by MCP client
- `host.reboot` requires secondary confirmation flag in API and UI.

## Transport Security

- API and UI are intended to run behind TLS in production.
- Agent MCP should bind localhost where possible.
- Non-localhost bind without TLS is rejected unless explicit dev override is enabled.

## Operational Security

- Rate limiting is applied to auth, AI, and proposal approval endpoints.
- Session/auth token expiry is configurable.
- Audit tables are append-only by service policy.
