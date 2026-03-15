<!--
Copyright (c) 2026 Homelab Control Plane contributors
SPDX-License-Identifier: MIT

This document describes testing agent behavior and expectations.
-->

# Testing Guide For AI Coding Agents

Last verified: 2026-03-13

This guide defines how an AI coding agent should validate this repository and report results.

## Required Dependencies

- `bash`
- `git`
- Node.js `22.x`
- `pnpm` `9.15.4`
- Go `1.23.x` for `apps/agent`
- Docker and Docker Compose when validating the full stack

## Setup

```bash
corepack enable
pnpm install
```

If you need local env files for stack or Compose validation:

```bash
./scripts/setup-env.sh --non-interactive --force
```

## Suggested Validation Order

### Fast Validation

```bash
pnpm repo:hygiene
pnpm --filter @homelab/shared test
pnpm --filter @homelab/web test
pnpm --filter @homelab/worker test
pnpm --filter @homelab/api test
```

If Go is available:

```bash
(cd apps/agent && GOCACHE=/tmp/go-build go test ./...)
```

### Full Validation

```bash
pnpm quality:preflight
pnpm lint
pnpm typecheck
pnpm test
```

### CI-Parity Suites

```bash
pnpm test:coverage
pnpm --filter @homelab/web test:e2e:mock
pnpm --filter @homelab/web test:e2e:smoke
bash ./scripts/go-coverage-gate.sh
```

## Reporting Format

Every testing report should include:

1. Environment summary
2. Commands executed
3. Pass or fail per command
4. Failing tests with file, test name, and first useful error line
5. Blockers or skipped suites
6. Clear next action

Use this structure:

```md
## Test Environment

- Node: <version>
- pnpm: <version>
- Go: <version or "not installed">

## Commands Run

1. `<command>`
2. `<command>`

## Results

- PASS: `<command>`
- FAIL: `<command>`

## Failures

- `<file>::<test name>` -> `<first useful assertion or error line>`

## Blockers / Notes

- <sandbox, dependency, or infra limitation>

## Recommended Next Step

- <single most useful next action>
```

## Rules

- Do not claim a full pass if any command failed.
- State exactly which suites were skipped and why.
- Prefer targeted package-level runs before broad monorepo runs.
- If `pnpm test` fails only because sandboxed Go networking is blocked, report that as an environment limitation instead of hiding it.
