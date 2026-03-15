<!--
Copyright (c) 2026 Homelab Control Plane contributors
SPDX-License-Identifier: MIT

This document describes environment setup behavior and expectations.
-->

# Environment Setup Guide

Last verified: 2026-03-14

This repository uses `scripts/setup-env.sh` to generate local env files for API, web, worker, and Docker Compose.

## Generated Files

- `apps/api/.env`
- `apps/web/.env`
- `apps/worker/.env`
- `infra/compose/.env`

## Common Usage

Interactive:

```bash
./scripts/setup-env.sh
```

Non-interactive:

```bash
./scripts/setup-env.sh --non-interactive --force
```

Dry run:

```bash
./scripts/setup-env.sh --dry-run
```

## What The Script Collects

- browser-facing API URL
- web origin for CORS
- `JWT_SECRET`
- `APP_MASTER_KEY`
- `POSTGRES_PASSWORD` for Docker Compose
- `OPENAI_MODEL`
- agent-install queue and binary-store settings
- service discovery toggles
- local and Compose `DATABASE_URL` / `REDIS_URL`

The script does not generate bundled agents, sample seed data, or an OpenAI API key.

## Key Output Variables

### `apps/api/.env`

- `DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`
- `APP_MASTER_KEY`
- `WEB_ORIGIN`
- `OPENAI_MODEL`
- `AGENT_INSTALL_*`
- `DISCOVERY_*`

### `apps/worker/.env`

- `DATABASE_URL`
- `REDIS_URL`
- `APP_MASTER_KEY`
- `RETENTION_DAYS`

### `apps/web/.env`

- `VITE_API_BASE_URL`

### `infra/compose/.env`

- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`
- `APP_MASTER_KEY`
- `WEB_ORIGIN`
- `VITE_API_BASE_URL`
- `OPENAI_MODEL`
- `AGENT_INSTALL_*`
- `DISCOVERY_*`
- logging controls such as `HOST_LOG_ROOT` and `*_LOG_FILE_PATH`

## First-Run Auth

The API bootstraps a built-in local admin record automatically on startup. No password is shipped in env files.

On first visit, the UI calls `GET /api/auth/setup-status` and prompts you to set the admin password before normal sign-in is enabled.

## OpenAI Provider Key

The OpenAI API key is no longer written into `apps/api/.env` or `infra/compose/.env`.

After the first admin login, open **Settings** and configure the key there if you want model-backed AI features. The key is stored separately from the generated env files.

## Next Steps

Validate and start the stack with the generated Compose env file:

```bash
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml config
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml up -d --build
```

Then:

- open the UI
- set the admin password
- optionally configure the OpenAI API key in Settings
- enroll or install real agents explicitly
