<!--
Copyright (c) 2026 Homelab Control Plane contributors
SPDX-License-Identifier: MIT

This document provides operational guidance for coding agents working in the repository.
-->

# Agent Review Guidelines

Last verified: 2026-03-04

All contributions must satisfy these checks before merge:

- Verify auth middleware/guards wrap every API route except explicitly public bootstrap routes.
- Never log secrets, tokens, keys, raw credential payloads, or redacted fields.
- All write actions require explicit approval and emit an `audit_events` record.
- Do not introduce arbitrary command execution; diagnostics must stay allowlisted.
