/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the constants logic for the repository.
 */
/**
 * Lists the write tools identifiers.
 */
export const WRITE_TOOLS = new Set([
  'services.restart',
  'containers.restart',
  'compose.redeploy',
  'host.reboot',
  'agent.telemetry.set_config',
  'agent.telemetry.refresh_now',
]);

/**
 * Renders the sensitive read tools view.
 */
export const SENSITIVE_READ_TOOLS = new Set(['logs.tail']);

/**
 * Renders the read only tools view.
 */
export const READ_ONLY_TOOLS = new Set([
  'host.status',
  'process.snapshot',
  'service.probe',
  'terminal.exec',
  'agent.telemetry.get_config',
  'host.top_processes',
  'services.list',
  'containers.list',
  'network.scan_known_services',
  'logs.tail',
  'network.ping',
  'network.traceroute',
  'storage.df',
]);
