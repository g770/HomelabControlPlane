<!--
Copyright (c) 2026 Homelab Control Plane contributors
SPDX-License-Identifier: MIT

This document describes operations behavior and expectations.
-->

# Operations

Last verified: 2026-03-13

## Maintenance Windows

Use silences during planned work:

- Create silence: `POST /api/silences`
- Expire silence: `DELETE /api/silences/:id`

## Backup and Restore

Recommended:

1. Daily PostgreSQL logical backup (`pg_dump`).
2. Redis persistence snapshots for queue state.
3. Store `APP_MASTER_KEY` securely; encrypted credentials are unrecoverable without it.

## Incident Flow

1. Check `/home` and `/alerts` for active incidents.
2. Inspect `/checks/:id/history` for repeated failures.
3. Use AI page for diagnostics and proposal drafting.
4. Approve write tools only after reviewing expected effect.
5. Validate recovery via checks and close alerts.

## SSH Terminal Troubleshooting

The browser SSH terminal is proxied by API service runtime. Connectivity must exist from API runtime to target host.

1. Verify API runtime reachability to target:
   - Docker compose: `docker exec -it homelab-api sh -lc 'ssh -o ConnectTimeout=5 user@<target> -p <port>'`
   - Local API process: run the same SSH command from API host shell.
2. If UI shows a session opened but no connection, inspect API logs for quick SSH exit or network refusal.
3. If an authentication prompt appears, answer it inside the embedded terminal. The optional password field is only a one-shot setup hint when the backend detects an initial prompt.
4. Ensure target host allows selected auth mode and source network from API runtime.
5. Terminal output includes `[debug]` lifecycle entries (session create, websocket attach, terminal close events). Capture `sessionId` and correlate with API logs.

## Host List Preferences

Host table settings are persisted per user in API-backed preferences:

- column visibility
- column widths

Use page-level `Reset columns` if a user needs to restore layout defaults.

## Dashboard Suggested Links Notice

The dashboard notice behavior:

- shown once per unique suggestion batch fingerprint
- dismissal stores fingerprint in user preferences
- notice reappears when discovery produces a different fingerprint

## Runtime Logging

Services support leveled logs (`error`, `warn`, `info`, `debug`, `trace`) with dual output to stdout and host-mounted files.

- Compose host log root default: `${HOST_LOG_ROOT:-./logs}`.
- With `docker compose -f infra/compose/docker-compose.yml ...`, that default resolves under `infra/compose/logs`.
- Default service log files:
  - API: `${HOST_LOG_ROOT}/api/api.log`
  - Worker: `${HOST_LOG_ROOT}/worker/worker.log`
  - Web: `${HOST_LOG_ROOT}/web/web.log`
  - Agent: `${HOST_LOG_ROOT}/agent/agent.log`
- Retention defaults:
  - `LOG_RETENTION_DAYS=14`
  - `LOG_MAX_BYTES_PER_SERVICE=1073741824` (1GB per service directory)
  - `LOG_ROTATE_FILE_SIZE_BYTES=52428800` (50MB active file rotation)

Quick checks:

- API SSH flow: `tail -f ${HOST_LOG_ROOT:-infra/compose/logs}/api/api.log`
- Worker jobs: `tail -f ${HOST_LOG_ROOT:-infra/compose/logs}/worker/worker.log`
- Agent telemetry/MCP: `tail -f ${HOST_LOG_ROOT:-infra/compose/logs}/agent/agent.log`
- Web runtime: `tail -f ${HOST_LOG_ROOT:-infra/compose/logs}/web/web.log`

## Retention

Worker cleanup job prunes old records based on `RETENTION_DAYS`.
Default is 30 days for check results, events, host facts, and AI messages.
