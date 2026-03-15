/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements dashboard agent mcp service business logic for the service layer.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { AlertEventStatus, EventSeverity } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const MAX_HISTORY_HOURS = 7 * 24;

type DashboardAgentToolName =
  | 'homelab.snapshot'
  | 'metrics.host.history'
  | 'monitors.results'
  | 'discovery.runs'
  | 'ai.questions'
  | 'events.recent';

@Injectable()
/**
 * Implements the dashboard agent mcp service class.
 */
export class DashboardAgentMcpService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns read only tools for the current workflow.
   */
  getReadOnlyTools(): DashboardAgentToolName[] {
    return [
      'homelab.snapshot',
      'metrics.host.history',
      'monitors.results',
      'discovery.runs',
      'ai.questions',
      'events.recent',
    ];
  }

  /**
   * Handles call tool.
   */
  async callTool(toolName: string, args: Record<string, unknown> = {}) {
    switch (toolName as DashboardAgentToolName) {
      case 'homelab.snapshot':
        return this.getHomelabSnapshot();
      case 'metrics.host.history':
        return this.getHostMetricHistory(args);
      case 'monitors.results':
        return this.getMonitorResults(args);
      case 'discovery.runs':
        return this.getDiscoveryRuns(args);
      case 'ai.questions':
        return this.getAiQuestions(args);
      case 'events.recent':
        return this.getRecentEvents(args);
      default:
        throw new BadRequestException(`Unsupported dashboard-agent MCP tool: ${toolName}`);
    }
  }

  /**
   * Gets homelab snapshot.
   */
  private async getHomelabSnapshot() {
    const [hosts, services, monitors, activeAlerts] = await Promise.all([
      this.prisma.host.count(),
      this.prisma.service.count(),
      this.prisma.check.count(),
      this.prisma.alertEvent.count({ where: { status: { not: AlertEventStatus.RESOLVED } } }),
    ]);

    return {
      hosts,
      services,
      monitors,
      activeAlerts,
    };
  }

  /**
   * Gets host metric history.
   */
  private async getHostMetricHistory(args: Record<string, unknown>) {
    const hours = readIntArg(args, 'hours', 24, 1, MAX_HISTORY_HOURS);
    const limitPerHost = readIntArg(args, 'limitPerHost', 96, 10, 1_000);
    const hostId = readOptionalStringArg(args, 'hostId');
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1_000);

    const hosts = await this.prisma.host.findMany({
      where: hostId ? { id: hostId } : undefined,
      orderBy: { hostname: 'asc' },
      select: {
        id: true,
        hostname: true,
        status: true,
        lastSeenAt: true,
        cpuPct: true,
        memPct: true,
        diskPct: true,
        facts: {
          where: {
            createdAt: {
              gte: cutoff,
            },
          },
          orderBy: { createdAt: 'desc' },
          take: limitPerHost,
          select: {
            createdAt: true,
            snapshot: true,
          },
        },
      },
    });

    return {
      hours,
      hosts: hosts.map((host) => {
        const pointsDescending = host.facts;
        const pointsAscending = [...pointsDescending].reverse();
        const points = pointsAscending.map((fact) => {
          const snapshot = toRecord(fact.snapshot);
          const cpuPct = pickNumber(snapshot, [
            ['cpu', 'usagePct'],
            ['cpu', 'pct'],
            ['cpu', 'totalPct'],
            ['cpuPct'],
          ]);
          const memPct = pickNumber(snapshot, [
            ['memory', 'usedPct'],
            ['memory', 'pct'],
            ['memoryPct'],
            ['memPct'],
          ]);
          const diskPct = pickNumber(snapshot, [
            ['storage', 'usedPct'],
            ['storage', 'pct'],
            ['diskPct'],
          ]);
          const networkKbps = pickNumber(snapshot, [
            ['network', 'throughputKbps'],
            ['network', 'kbps'],
            ['network', 'totalKbps'],
          ]);
          const diskIoOps = pickNumber(snapshot, [
            ['storage', 'io', 'iops'],
            ['storage', 'iops'],
            ['diskIoOps'],
          ]);

          return {
            at: fact.createdAt.toISOString(),
            cpuPct: roundMetric(cpuPct),
            memPct: roundMetric(memPct),
            diskPct: roundMetric(diskPct),
            networkKbps: roundMetric(networkKbps),
            diskIoOps: roundMetric(diskIoOps),
          };
        });

        return {
          hostId: host.id,
          hostName: host.hostname,
          status: host.status,
          lastSeenAt: host.lastSeenAt ? host.lastSeenAt.toISOString() : null,
          latest: {
            cpuPct: roundMetric(host.cpuPct),
            memPct: roundMetric(host.memPct),
            diskPct: roundMetric(host.diskPct),
          },
          points,
        };
      }),
    };
  }

  /**
   * Gets monitor results.
   */
  private async getMonitorResults(args: Record<string, unknown>) {
    const hours = readIntArg(args, 'hours', 24, 1, MAX_HISTORY_HOURS);
    const limitPerMonitor = readIntArg(args, 'limitPerMonitor', 30, 5, 500);
    const monitorId = readOptionalStringArg(args, 'monitorId');
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1_000);

    const checks = await this.prisma.check.findMany({
      where: monitorId ? { id: monitorId } : undefined,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        type: true,
        target: true,
        enabled: true,
        hostId: true,
        serviceId: true,
        results: {
          where: {
            checkedAt: {
              gte: cutoff,
            },
          },
          orderBy: { checkedAt: 'desc' },
          take: limitPerMonitor,
          select: {
            checkedAt: true,
            status: true,
            latencyMs: true,
            httpStatus: true,
            errorMessage: true,
          },
        },
      },
    });

    return {
      hours,
      monitors: checks.map((check) => {
        const downCount = check.results.filter((result) => result.status === 'DOWN').length;
        const warnCount = check.results.filter((result) => result.status === 'WARN').length;
        const unknownCount = check.results.filter((result) => result.status === 'UNKNOWN').length;

        return {
          id: check.id,
          name: check.name,
          type: check.type,
          target: check.target,
          enabled: check.enabled,
          hostId: check.hostId,
          serviceId: check.serviceId,
          latestStatus: check.results[0]?.status ?? 'UNKNOWN',
          downCount,
          warnCount,
          unknownCount,
          history: check.results.map((result) => ({
            checkedAt: result.checkedAt.toISOString(),
            status: result.status,
            latencyMs: result.latencyMs,
            httpStatus: result.httpStatus,
            errorMessage: result.errorMessage,
          })),
        };
      }),
    };
  }

  /**
   * Gets discovery runs.
   */
  private async getDiscoveryRuns(args: Record<string, unknown>) {
    const limit = readIntArg(args, 'limit', 8, 1, 50);

    const runs = await this.prisma.serviceDiscoveryRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        trigger: true,
        startedAt: true,
        finishedAt: true,
        status: true,
        detectedCount: true,
        upsertCount: true,
        errorCount: true,
        error: true,
        summary: true,
      },
    });

    return {
      runs: runs.map((run) => ({
        id: run.id,
        trigger: run.trigger,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
        status: run.status,
        detectedCount: run.detectedCount,
        upsertCount: run.upsertCount,
        errorCount: run.errorCount,
        error: run.error,
        summary: run.summary,
      })),
    };
  }

  /**
   * Gets ai questions.
   */
  private async getAiQuestions(args: Record<string, unknown>) {
    const limit = readIntArg(args, 'limit', 40, 1, 200);
    const hours = readIntArg(args, 'hours', 72, 1, MAX_HISTORY_HOURS);
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1_000);

    const messages = await this.prisma.aiMessage.findMany({
      where: {
        role: 'USER',
        createdAt: {
          gte: cutoff,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        conversationId: true,
        content: true,
        createdAt: true,
      },
    });

    return {
      hours,
      questions: messages.map((message) => ({
        id: message.id,
        conversationId: message.conversationId,
        createdAt: message.createdAt.toISOString(),
        text: compactText(message.content, 240),
      })),
    };
  }

  /**
   * Gets recent events.
   */
  private async getRecentEvents(args: Record<string, unknown>) {
    const limit = readIntArg(args, 'limit', 100, 1, 500);
    const hours = readIntArg(args, 'hours', 24, 1, MAX_HISTORY_HOURS);
    const severity = readEventSeverityArg(args, 'severity');
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1_000);

    const events = await this.prisma.event.findMany({
      where: {
        createdAt: {
          gte: cutoff,
        },
        severity: severity ?? undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        type: true,
        severity: true,
        message: true,
        hostId: true,
        serviceId: true,
        checkId: true,
        createdAt: true,
      },
    });

    return {
      hours,
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        severity: event.severity,
        message: compactText(event.message, 220),
        hostId: event.hostId,
        serviceId: event.serviceId,
        checkId: event.checkId,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }
}

/**
 * Implements round metric.
 */
function roundMetric(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 10) / 10;
}

/**
 * Implements compact text.
 */
function compactText(input: string, maxLength: number) {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

/**
 * Implements read int arg.
 */
function readIntArg(
  args: Record<string, unknown>,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
) {
  const raw = args[key];
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim().length > 0
        ? Number(raw)
        : defaultValue;

  if (!Number.isFinite(parsed)) {
    throw new BadRequestException(`Invalid number for ${key}`);
  }

  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

/**
 * Implements read optional string arg.
 */
function readOptionalStringArg(args: Record<string, unknown>, key: string) {
  const raw = args[key];
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Implements read event severity arg.
 */
function readEventSeverityArg(args: Record<string, unknown>, key: string) {
  const raw = args[key];
  if (typeof raw !== 'string') {
    return null;
  }
  const upper = raw.trim().toUpperCase();
  if (
    upper === EventSeverity.INFO ||
    upper === EventSeverity.WARN ||
    upper === EventSeverity.ERROR
  ) {
    return upper;
  }
  throw new BadRequestException(`Invalid severity value: ${raw}`);
}

/**
 * Implements pick number.
 */
function pickNumber(source: Record<string, unknown> | null, paths: string[][]) {
  if (!source) {
    return null;
  }

  for (const path of paths) {
    let current: unknown = source;
    for (const segment of path) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }

    const maybe = coerceNumber(current);
    if (maybe !== null) {
      return maybe;
    }
  }

  return null;
}

/**
 * Implements coerce number.
 */
function coerceNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

/**
 * Implements to record.
 */
function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
