<!--
Copyright (c) 2026 Homelab Control Plane contributors
SPDX-License-Identifier: MIT

This document introduces the Homelab Dash repository and its core workflows.
-->

# Homelab Control Plane Monorepo

Last verified: 2026-03-14

## Overview

This repository contains a full homelab control-plane stack:

- React dashboard in `apps/web`
- NestJS API in `apps/api`
- BullMQ worker in `apps/worker`
- Go LabAgent with MCP server in `apps/agent`
- Shared schemas and API client types in `packages/shared`
- Docker Compose development stack in `infra/compose`

Default startup is intentionally clean: no sample data is seeded and no bundled agent is started. Enroll or install agents explicitly after bootstrap.

## Prerequisites

- Node.js `22.x`
- `pnpm` `9.15.4` via `corepack`
- Go `1.23.x` for agent development and tests
- Docker and Docker Compose for the full local stack

Ubuntu and Debian contributor bootstrap: `./bootstrap-dev-env.sh`

## Quick Start

1. Enable package tooling and install dependencies:

   ```bash
   corepack enable
   pnpm install
   ```

2. Generate local environment files:

   ```bash
   ./scripts/setup-env.sh
   ```

3. Validate the Compose configuration:

   ```bash
   docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml config
   ```

4. Start the local stack:

   ```bash
   docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml up -d --build
   ```

5. Open the UI at `http://localhost:5173`.
6. On first load, set the password for the built-in local admin account.
7. If you want model-backed AI features, configure the OpenAI API key from Settings after signing in.
8. Enroll or install real agents from the dashboard when you are ready to connect hosts.

## Contributor Workflow

Core commands:

- `pnpm repo:hygiene`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm --filter @homelab/web test:e2e:mock`
- `pnpm --filter @homelab/web test:e2e:smoke`
- `bash ./scripts/go-coverage-gate.sh`
- `make clean-generated`

Convenience targets:

- `make dev`
- `make compose-up`
- `make compose-down`
- `make agent-build`
- `make quality-check`

## Documentation

- Setup and env generation: `docs/ENVIRONMENT_SETUP.md`
- Runtime operations: `docs/OPERATIONS.md`
- Security model: `docs/SECURITY.md`
- LabAgent behavior and MCP surface: `docs/AGENT.md`
- Repository quality gates: `docs/CODE_QUALITY_STANDARDS.md`
- AI-agent testing guide: `TESTING_AGENT.md`
- Contributor instructions: `CONTRIBUTING.md`

## Security Notes

- Non-public API routes must remain guarded.
- Write actions require explicit approval and audit events.
- Diagnostics stay allowlisted; no arbitrary shell execution is permitted.
- Runtime secrets must come from env files or deployment configuration, not executable fallbacks.
- The OpenAI API key is configured later from Settings and is not generated into local env files.

Top-level vulnerability reporting guidance lives in `SECURITY.md`.
