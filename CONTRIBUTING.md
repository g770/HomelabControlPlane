<!--
Copyright (c) 2026 Homelab Control Plane contributors
SPDX-License-Identifier: MIT

This document describes how contributors should work with the repository.
-->

# Contributing

Last verified: 2026-03-13

## Development Baseline

- Node.js `22.x`
- `pnpm` `9.15.4` via `corepack`
- Go `1.23.x` for `apps/agent`
- Docker and Docker Compose for the full local stack

Quick setup:

```bash
corepack enable
pnpm install
./scripts/setup-env.sh --non-interactive --force
docker compose -f infra/compose/docker-compose.yml up -d --build
```

The first browser login flow is bootstrap-only. The API creates the built-in local admin record on startup, and you set the password through the UI on first use.

## Branch and PR Expectations

- Keep changes focused. Split unrelated cleanup, feature work, and refactors into separate PRs.
- Update docs when behavior, commands, or configuration changes.
- Include tests for behavior changes when a stable test layer exists.
- Do not commit `.env` files, generated logs, coverage output, or local build artifacts.

## Required Checks

Run these before opening a PR:

```bash
pnpm quality:preflight
pnpm repo:hygiene
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @homelab/web test:e2e:mock
pnpm --filter @homelab/web test:e2e:smoke
bash ./scripts/go-coverage-gate.sh
```

Use `make clean-generated` before packaging changes or preparing screenshots if you need to clear local output directories.

## Security and Safety Rules

All contributions must preserve these repository guarantees:

- Protect every non-public API route with auth middleware or guards.
- Never log secrets, tokens, raw credentials, or redacted payloads.
- Require explicit approval and write an `audit_events` record for every write action.
- Keep diagnostics and operational commands allowlisted. Do not introduce arbitrary command execution.

## Review Notes

- Call out any new environment variables in the PR description and update `*.env.example` plus setup docs in the same change.
- If a change modifies contributor workflow, update `README.md` and `TESTING_AGENT.md`.
- If you cannot run a required suite locally, state the exact blocker and the commands you did run.
