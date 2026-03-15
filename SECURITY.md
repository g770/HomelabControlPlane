<!--
Copyright (c) 2026 Homelab Control Plane contributors
SPDX-License-Identifier: MIT

This document captures security expectations and disclosure guidance for the project.
-->

# Security Policy

Last verified: 2026-03-13

## Reporting A Vulnerability

- Do not open a public GitHub issue for suspected credential exposure, privilege escalation, remote execution, or auth bypass.
- Use GitHub private vulnerability reporting if it is enabled for the repository.
- If private reporting is unavailable, contact the maintainer through a private channel before disclosing details publicly.

Include:

- affected version or commit
- reproduction steps
- impact assessment
- any proof-of-concept artifacts needed to validate the issue

## Response Scope

- Primary support target: the current `main` branch
- Best-effort review for recently released commits
- No guarantee for long-lived private forks with local-only modifications

## Repository Security Model

The technical controls and operational assumptions for this project are documented in `docs/SECURITY.md`.
