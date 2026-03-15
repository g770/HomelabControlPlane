<!--
Copyright (c) 2026 Homelab Control Plane contributors
SPDX-License-Identifier: MIT

This document provides operational guidance for coding agents working in the repository.
-->

# LabAgent Guide

Last verified: 2026-03-13

This document describes the LabAgent command surface, runtime behavior, MCP capabilities, and operational limits in this repository.

## Command Surface

- `labagent enroll --control-plane URL --token TOKEN --mcp-bind ADDR --mcp-port PORT [--mcp-advertise-url URL]`
- `labagent run --control-plane URL --agent-id ID --agent-token TOKEN --mcp-bind ADDR --mcp-port PORT`
- `labagent version`
- `labagent status` (informational placeholder in this build)

## Runtime Behavior

When `labagent run` starts, it:

1. Starts MCP HTTP server on `--mcp-bind` + `--mcp-port`.
2. Sends initial heartbeat, facts snapshot, and inventory snapshot to the control plane.
3. Runs periodic loops:
   - heartbeat: every `15s` by default (`--heartbeat-sec`)
   - facts: every `300s` by default (`--facts-sec`)
   - inventory: every `60s` by default (`--inventory-sec`)
4. Emits host events when thresholds/state changes are detected.

## Control Plane Integration

Agent API calls:

- `POST /api/agents/enroll`
- `POST /api/agents/:agentId/heartbeat`
- `POST /api/agents/:agentId/facts`
- `POST /api/agents/:agentId/inventory`
- `POST /api/agents/:agentId/events`

Heartbeat includes capability metadata (`tools`, `resources`, `prompts`).

Enrollment stores agent endpoints:

- endpoint: `http://<mcp-bind>:<mcp-port>`
- MCP endpoint: `<endpoint>/mcp`
- use `--mcp-advertise-url` when bind address is not routable by the API

## Off-Box MCP Reachability

`--mcp-bind` controls socket binding. `--mcp-advertise-url` controls the endpoint persisted in API.

- Use `--mcp-bind` for local listener behavior (for example, `0.0.0.0` in container).
- Use `--mcp-advertise-url` for routable API access.

Examples:

- Remote host agent:
  - `--mcp-bind 0.0.0.0 --mcp-advertise-url http://192.168.10.55:8081 --allow-insecure-dev`
- Compose-network agent:
  - `--mcp-bind 0.0.0.0 --mcp-advertise-url http://agent:8081 --allow-insecure-dev`

If `--mcp-bind` is wildcard (`0.0.0.0`/`::`), `--mcp-advertise-url` is required.

For subnet scanning, the agent runtime must have network reachability to target CIDRs. Containerized agents running on bridge networking may not reach full physical LAN segments.

## Host Data Collection

### Facts Snapshot

- hostname and static tags (`linux`, `labagent`)
- CPU usage and core count
- memory usage
- disk usage summary
- network interface counters
- OS/kernel/distro and uptime
- agent version

### Inventory Snapshot

- systemd services and failed count (when `systemctl` is available)
- Docker container summary (when Docker access is available)
- network interface summary
- storage mounts and usage

### Event Detection

WARN events are emitted for:

- high CPU (`cpuPct > 90`)
- memory threshold crossing (`memPct > 90` crossing from <= 90)
- disk threshold crossing (`diskPct > 85` crossing from <= 85)
- failed systemd units (`failedCount > 0`)

## MCP Protocol

Endpoint: `GET/POST /mcp`

Supported JSON-RPC methods:

- `initialize`
- `resources/list`
- `resources/read`
- `tools/list`
- `tools/call`
- `prompts/list`
- `prompts/get`

## MCP Resources

- `host://facts`
- `host://services`
- `host://containers`
- `host://metrics/summary`
- `host://events/recent`

## MCP Tools

### Read Tools

- `host.status`: runtime host snapshot
- `process.snapshot`: bounded process snapshot (`limit` capped at `500`)
- `service.probe`: allowlisted local probe (`http`/`https`/`tcp`, bounded timeout)
- `terminal.exec`: allowlisted diagnostic command router
  - allowed commands: `help`, `status`, `services`, `containers`, `df`, `ls [path]`, `ping`, `traceroute`, `logs`
  - no arbitrary shell execution
- `agent.telemetry.get_config`: current telemetry interval configuration
- `services.list`: discovered systemd services
- `containers.list`: discovered containers
- `logs.tail`:
  - `journalctl` source requires `ref` unit name
  - `file` source is restricted to `/var/log/...` or `/tmp/...`
  - `lines` bounded `1..1000`, `sinceSec` bounded `>= 0`
  - output is always redacted and tagged with `redacted: true`
- `network.ping`: target required, `count` bounded `1..5`
- `network.traceroute`: target required, `maxHops` bounded `1..30`
- `network.scan_known_services`:
  - bounded subnet scanner for known signatures/common web ports
  - controls: `maxHosts` (`1..4096`), `concurrency` (`1..128`), `connectTimeoutMs` (`100..10000`)
- `storage.df`: disk usage output with redaction

### Write Tools

- `agent.telemetry.set_config`:
  - requires `confirm=true`
  - requires at least one of `heartbeatSec`, `factsSec`, `inventorySec`
- `agent.telemetry.refresh_now`:
  - requires `confirm=true`
- `services.restart`: validated systemd unit restart
- `containers.restart`: validated Docker container id/name token restart
- `compose.redeploy`: `docker compose -p <project> up -d` with validated project token
- `host.reboot` (high risk): requires `confirm=true`, schedules reboot (`shutdown -r +1`)

## MCP Prompts

- Diagnose high CPU
- Investigate disk pressure
- Why is service unhealthy?
- Prepare maintenance plan

## Linux Installation

1. Build binary:
   - `cd apps/agent`
   - `go build -o labagent ./cmd/labagent`
2. Copy binary to target host (for example `/usr/local/bin/labagent`).
3. Enroll with an enrollment token from Settings.
4. Start with `run` command using returned `agentId` + `agentToken`.

When using `scripts/install-labagent.sh`, install defaults to replace-first flow:

- stops/removes existing service + env/binary artifacts for selected service name
- reenrolls and writes fresh `AGENT_ID` + `AGENT_TOKEN`
- revokes one-time enrollment token after execution
- use `--keep-existing` (or disable replace-first option in Settings) to skip cleanup

## Containerized Build (No Local Go Required)

From repo root:

- default target: `./scripts/build-labagent-container.sh`
- specific target: `./scripts/build-labagent-container.sh --os linux --arch arm64 --output dist/agent`
- matrix build: `./scripts/build-labagent-container.sh --matrix`

## Remote Uninstall (Settings UI)

1. Open **Settings -> Agent Management**.
2. Click **Uninstall Agent** on target agent card.
3. Provide SSH credentials and execute request.

The operation reuses the latest successful install request for rollback-safe uninstall, then revokes the target agent row/token on success.

## systemd Service Example

```ini
[Unit]
Description=Homelab LabAgent
After=network-online.target

[Service]
ExecStart=/usr/local/bin/labagent run --control-plane http://control-plane.local:4000 --agent-id <id> --agent-token <token> --mcp-bind 0.0.0.0 --mcp-port 8081 --allow-insecure-dev
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## Security and Safety Controls

- MCP requires `Authorization: Bearer <agentToken>`.
- `Origin` is validated when present; invalid origin returns `403`.
- Default bind is localhost; non-localhost bind needs explicit `--allow-insecure-dev`.
- Wildcard bind requires `--mcp-advertise-url` during enrollment.
- Agent does not provide arbitrary shell execution; diagnostics/actions are allowlisted.
- Tool output redaction covers bearer tokens, key blocks, secret-like env vars, and auth header values.

## Current Functional Limits

- `labagent status` is informational in this build (no persisted status backend).
- Some inventory/tools depend on host binaries and permissions (`systemctl`, `docker`, `journalctl`, `ping`, `traceroute`).
- Historical `host.top_processes` naming has been replaced by `process.snapshot` in this build.
