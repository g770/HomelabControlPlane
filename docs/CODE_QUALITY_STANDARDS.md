<!--
Copyright (c) 2026 Homelab Control Plane contributors
SPDX-License-Identifier: MIT

This document describes code quality standards behavior and expectations.
-->

# Code Quality Standards

Last verified: 2026-03-13

## Toolchain Baseline

- Node.js `22+`
- `pnpm` `9.15.4`
- Go `1.23+` for `apps/agent`
- Run `pnpm quality:preflight` before broader validation

## Required Checks

- `pnpm repo:hygiene`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage`
- `pnpm --filter @homelab/web test:e2e:mock`
- `pnpm --filter @homelab/web test:e2e:smoke`
- `bash ./scripts/go-coverage-gate.sh`

## Readability Rules

- Keep modules focused and split files when responsibilities diverge.
- Prefer domain names over implementation-detail names.
- Add short comments only where constraints or behavior are non-obvious.
- Remove stale comments when behavior changes.

## Type And Lint Rules

- No lint warnings in changed code.
- `@typescript-eslint/no-explicit-any` is disallowed in non-test TypeScript source.
- `react-hooks/exhaustive-deps` is enforced as an error.
- `no-console` is disallowed except runtime entrypoints and operational scripts launched directly from the CLI.
- Frontend API responses should use explicit shared or local API types, not untyped `unknown` plumbing where stable types exist.

## Security-Specific Requirements

- Auth guards must protect non-public API routes.
- Write paths must require explicit approval and produce audit records.
- Do not log secrets, tokens, or raw credential payloads.
- Diagnostics and tool execution must remain allowlisted.
- Runtime secrets must be provided by environment configuration, not executable fallback literals.
