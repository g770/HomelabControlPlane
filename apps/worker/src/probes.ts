/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the probes logic for the repository.
 */
import net from 'node:net';
import ping from 'ping';

/**
 * Describes the check result status value shape.
 */
export type CheckResultStatusValue = 'UP' | 'DOWN' | 'WARN' | 'UNKNOWN';

/**
 * Describes the http check input shape.
 */
export type HttpCheckInput = {
  target: string;
  timeoutMs: number;
  expectedStatus: number | null;
  keyword: string | null;
};

/**
 * Describes the tcp check input shape.
 */
export type TcpCheckInput = {
  target: string;
  timeoutMs: number;
};

/**
 * Describes the icmp check input shape.
 */
export type IcmpCheckInput = {
  target: string;
  timeoutMs: number;
};

/**
 * Describes the http probe result shape.
 */
export type HttpProbeResult = {
  status: CheckResultStatusValue;
  latencyMs: number;
  httpStatus: number | null;
  errorMessage: string | null;
};

/**
 * Describes the probe result shape.
 */
export type ProbeResult = {
  status: CheckResultStatusValue;
  latencyMs: number;
  errorMessage: string | null;
};

// HTTP probe with timeout and optional status/body assertions.
export async function runHttpCheck(check: HttpCheckInput): Promise<HttpProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), check.timeoutMs);

  try {
    const response = await fetch(check.target, { signal: controller.signal });
    const body = await response.text();
    const okStatus = check.expectedStatus ? response.status === check.expectedStatus : response.ok;
    const okKeyword = check.keyword ? body.includes(check.keyword) : true;

    return {
      status: okStatus && okKeyword ? 'UP' : 'DOWN',
      latencyMs: Date.now() - started,
      httpStatus: response.status,
      errorMessage: okStatus && okKeyword ? null : 'Expectation mismatch',
    };
  } catch (error) {
    return {
      status: 'DOWN',
      latencyMs: Date.now() - started,
      httpStatus: null,
      errorMessage: error instanceof Error ? error.message : 'HTTP check failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

// TCP probe implemented with raw sockets to capture latency and timeout failures.
export function runTcpCheck(check: TcpCheckInput): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const [host, portText] = check.target.split(':');
    const port = Number(portText);
    if (!host || Number.isNaN(port)) {
      resolve({ status: 'DOWN', latencyMs: 0, errorMessage: 'Invalid target' });
      return;
    }

    const started = Date.now();
    const socket = new net.Socket();

    /**
     * Implements cleanup.
     */
    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(check.timeoutMs);

    socket.on('connect', () => {
      const latencyMs = Date.now() - started;
      cleanup();
      resolve({ status: 'UP', latencyMs, errorMessage: null });
    });

    socket.on('error', (error) => {
      cleanup();
      resolve({ status: 'DOWN', latencyMs: Date.now() - started, errorMessage: error.message });
    });

    socket.on('timeout', () => {
      cleanup();
      resolve({ status: 'DOWN', latencyMs: Date.now() - started, errorMessage: 'TCP timeout' });
    });

    socket.connect(port, host);
  });
}

// ICMP probe via ping library with timeout derived from monitor config.
export async function runIcmpCheck(check: IcmpCheckInput): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const result = await ping.promise.probe(check.target, {
      timeout: Math.ceil(check.timeoutMs / 1000),
    });
    return {
      status: result.alive ? 'UP' : 'DOWN',
      latencyMs: Date.now() - started,
      errorMessage: result.alive ? null : 'ICMP probe failed',
    };
  } catch (error) {
    return {
      status: 'DOWN',
      latencyMs: Date.now() - started,
      errorMessage: error instanceof Error ? error.message : 'ICMP check failed',
    };
  }
}
