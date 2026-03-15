/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements terminal service business logic for the service layer.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  terminalSshSocketClientMessageSchema,
  type TerminalSshSessionCreateRequest,
  type TerminalSshSessionInputRequest,
  type TerminalSshSocketServerMessage,
} from '@homelab/shared';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { spawn, type IPty } from 'node-pty';
import type { RawData, WebSocket } from 'ws';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { McpService } from '../mcp/mcp.service';
import { apiRuntimeLogger } from '../common/runtime-logger';

type SshSession = {
  id: string;
  ownerUserId: string;
  hostId: string;
  hostName: string;
  target: string;
  username: string;
  port: number;
  process: IPty;
  processExited?: boolean;
  subscribers: Set<Response>;
  socket?: WebSocket;
  backlog: string[];
  openedAt: string;
  closedAt?: string;
  closedReason?: string;
  keepalive?: NodeJS.Timeout;
  cleanupTimer?: NodeJS.Timeout;
  authPassword?: string;
  authPasswordSent?: boolean;
  authPromptBuffer?: string;
  awaitingFirstAttachSinceMs?: number;
  attachTimer?: NodeJS.Timeout;
};

const maxBacklogChunks = 500;
const maxBacklogChunkSize = 8192;
const sessionIdleTtlMs = 30 * 60_000;
const sessionClosedRetentionMs = 2 * 60_000;
const sessionAttachTimeoutMs = 20_000;
const defaultPtyCols = 120;
const defaultPtyRows = 32;
const websocketOpenState = 1;

@Injectable()
/**
 * Implements the terminal service class.
 */
export class TerminalService {
  private readonly logger = apiRuntimeLogger;
  private readonly sshSessions = new Map<string, SshSession>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mcpService: McpService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Handles execute host command.
   */
  async executeHostCommand(actorUserId: string, hostId: string, command: string) {
    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      throw new BadRequestException('Command is required');
    }
    if (trimmedCommand.length > 240) {
      throw new BadRequestException('Command is too long');
    }

    const host = await this.prisma.host.findUnique({
      where: { id: hostId },
      select: {
        id: true,
        hostname: true,
      },
    });
    if (!host) {
      throw new NotFoundException('Host not found');
    }

    const agent = await this.prisma.agent.findFirst({
      where: {
        hostId,
        revokedAt: null,
      },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true },
    });
    if (!agent) {
      throw new NotFoundException('No active agent is enrolled for this host');
    }

    const raw = await this.mcpService.callTool({
      actorUserId,
      agentId: agent.id,
      toolName: 'terminal.exec',
      toolParams: {
        command: trimmedCommand,
      },
    });

    const result = toRecord(raw.result);
    const ok = typeof result?.ok === 'boolean' ? result.ok : true;
    const output = readOutput(result);

    return {
      hostId: host.id,
      hostName: host.hostname,
      agentId: agent.id,
      command: trimmedCommand,
      ok,
      output,
      result,
      executedAt: new Date().toISOString(),
    };
  }

  async createSshSession(
    actorUserId: string,
    hostId: string,
    request: TerminalSshSessionCreateRequest,
  ) {
    if (request.confirm !== true) {
      throw new BadRequestException('SSH session requires explicit confirmation');
    }

    const host = await this.prisma.host.findUnique({
      where: { id: hostId },
      include: {
        agent: {
          select: {
            endpoint: true,
            mcpEndpoint: true,
          },
        },
        facts: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            snapshot: true,
          },
        },
      },
    });
    if (!host) {
      throw new NotFoundException('Host not found');
    }

    const discoveredTarget =
      extractHostIp(host.facts[0]?.snapshot) ??
      extractHostFromEndpoint(host.agent?.endpoint) ??
      extractHostFromEndpoint(host.agent?.mcpEndpoint) ??
      host.hostname;
    const requestedTarget = (request.target ?? '').trim();
    const target = requestedTarget.length > 0 ? requestedTarget : discoveredTarget;
    const username = sanitizeSshUsername(request.username ?? 'root');
    const port = normalizePort(request.port);
    const authPassword = normalizeSshPassword(request.password);

    if (!isSafeSshTarget(target)) {
      throw new BadRequestException('Invalid SSH target');
    }

    const sessionId = randomUUID();
    const sshArgs = [
      '-tt',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      `ConnectTimeout=${15}`,
      '-p',
      String(port),
      `${username}@${target}`,
    ];

    const child = spawn('ssh', sshArgs, {
      cols: defaultPtyCols,
      rows: defaultPtyRows,
      cwd: process.cwd(),
      name: process.env.TERM ?? 'xterm-256color',
      env: {
        ...process.env,
        TERM: process.env.TERM ?? 'xterm-256color',
      },
    });

    const session: SshSession = {
      id: sessionId,
      ownerUserId: actorUserId,
      hostId: host.id,
      hostName: host.hostname,
      target,
      username,
      port,
      process: child,
      subscribers: new Set(),
      backlog: [],
      openedAt: new Date().toISOString(),
      authPassword,
      authPasswordSent: false,
      authPromptBuffer: '',
      awaitingFirstAttachSinceMs: Date.now(),
    };
    this.sshSessions.set(session.id, session);
    this.armFirstAttachTimeout(session);
    this.touchSessionTtl(session);
    this.logger.info('SSH session created', {
      sessionId: session.id,
      actorUserId,
      hostId: host.id,
      hostName: host.hostname,
      target,
      username,
      port,
    });
    this.logger.debug('SSH process spawned', {
      sessionId: session.id,
      hostId: host.id,
      target,
      username,
      port,
      args: sshArgs.join(' '),
    });

    child.onData((chunk) => {
      this.pushSessionOutput(session.id, chunk);
      this.tryAutoSubmitPassword(session.id, chunk);
    });
    child.onExit(({ exitCode, signal }) => {
      session.processExited = true;
      this.logger.info('SSH process exited', {
        sessionId: session.id,
        hostId: host.id,
        target,
        code: exitCode ?? null,
        signal: signal ?? null,
      });
      this.finalizeSshSession(
        session.id,
        `ssh_exit code=${exitCode ?? 'null'} signal=${signal ?? 'null'}`,
      );
    });

    await this.auditService.write({
      actorUserId,
      action: 'terminal.ssh.session.create',
      targetType: 'host',
      targetId: host.id,
      paramsJson: {
        hostId: host.id,
        hostName: host.hostname,
        target,
        username,
        port,
      },
      success: true,
    });

    return {
      sessionId: session.id,
      hostId: host.id,
      hostName: host.hostname,
      target,
      username,
      port,
      openedAt: session.openedAt,
    };
  }

  /**
   * Implements the attach web socket workflow for this file.
   */
  attachWebSocket(actorUser: { sub: string }, sessionId: string, socket: WebSocket) {
    const session = this.getOwnedSession(sessionId, actorUser.sub);
    this.markAttached(session, actorUser.sub, 'socket');

    if (session.socket && session.socket !== socket) {
      closeSocket(session.socket, 4001, 'terminal replaced by a newer attachment');
    }
    session.socket = socket;
    this.touchSessionTtl(session);

    sendSocketMessage(socket, {
      type: 'attached',
      sessionId: session.id,
      target: session.target,
      username: session.username,
      port: session.port,
      openedAt: session.openedAt,
    });

    for (const chunk of session.backlog) {
      sendSocketMessage(socket, {
        type: 'output',
        chunk,
      });
    }

    if (session.closedAt) {
      sendSocketMessage(socket, {
        type: 'close',
        closedAt: session.closedAt,
        reason: session.closedReason ?? 'closed',
        sessionId: session.id,
      });
      closeSocket(socket, 1000, session.closedReason ?? 'closed');
      return;
    }

    socket.on('message', (raw: RawData) => {
      this.handleSocketMessage(session.id, actorUser.sub, socket, raw);
    });
    socket.on('close', () => {
      if (session.socket === socket) {
        session.socket = undefined;
      }
      this.logger.trace('SSH websocket subscriber disconnected', {
        sessionId: session.id,
        actorUserId: actorUser.sub,
        hostId: session.hostId,
      });
    });
    socket.on('error', (error: Error) => {
      this.logger.debug('SSH websocket error', {
        sessionId: session.id,
        actorUserId: actorUser.sub,
        hostId: session.hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Handles stream ssh session.
   */
  streamSshSession(actorUserId: string, sessionId: string, response: Response) {
    const session = this.getOwnedSession(sessionId, actorUserId);
    this.markAttached(session, actorUserId, 'stream');

    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    writeSse(response, 'ready', {
      sessionId: session.id,
      target: session.target,
      username: session.username,
      port: session.port,
      openedAt: session.openedAt,
    });

    for (const chunk of session.backlog) {
      writeSse(response, 'output', { chunk });
    }
    if (session.closedAt) {
      writeSse(response, 'close', {
        sessionId: session.id,
        closedAt: session.closedAt,
        reason: session.closedReason ?? 'closed',
      });
      response.end();
      return;
    }

    session.subscribers.add(response);
    this.touchSessionTtl(session);

    response.on('close', () => {
      session.subscribers.delete(response);
      this.logger.trace('SSH stream subscriber disconnected', {
        sessionId: session.id,
        actorUserId,
        hostId: session.hostId,
      });
    });
  }

  writeSshSessionInput(
    actorUserId: string,
    sessionId: string,
    input: TerminalSshSessionInputRequest,
  ) {
    const session = this.getOwnedSession(sessionId, actorUserId);
    if (session.closedAt) {
      throw new BadRequestException('SSH session is closed');
    }

    const data = input.appendNewline ? `${input.data}\n` : input.data;
    session.process.write(data);
    this.touchSessionTtl(session);
    this.logger.trace('SSH input forwarded', {
      sessionId: session.id,
      actorUserId,
      hostId: session.hostId,
      bytes: Buffer.byteLength(data),
      appendNewline: input.appendNewline,
    });

    return {
      ok: true,
      sessionId: session.id,
    };
  }

  /**
   * Handles close ssh session.
   */
  async closeSshSession(actorUserId: string, sessionId: string) {
    const session = this.getOwnedSession(sessionId, actorUserId);
    this.finalizeSshSession(session.id, 'closed_by_user');
    this.logger.info('SSH session closed by user', {
      sessionId: session.id,
      actorUserId,
      hostId: session.hostId,
      target: session.target,
      username: session.username,
      port: session.port,
    });

    await this.auditService.write({
      actorUserId,
      action: 'terminal.ssh.session.close',
      targetType: 'host',
      targetId: session.hostId,
      paramsJson: {
        sessionId: session.id,
        target: session.target,
        username: session.username,
        port: session.port,
      },
      success: true,
    });

    return {
      ok: true,
      sessionId: session.id,
    };
  }

  /**
   * Handles socket message.
   */
  private handleSocketMessage(
    sessionId: string,
    actorUserId: string,
    socket: WebSocket,
    raw: unknown,
  ) {
    const session = this.getOwnedSession(sessionId, actorUserId);
    if (session.closedAt) {
      sendSocketMessage(socket, {
        type: 'error',
        message: 'SSH session is closed',
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawSocketMessageToString(raw));
    } catch {
      sendSocketMessage(socket, {
        type: 'error',
        message: 'Invalid websocket payload',
      });
      return;
    }

    const result = terminalSshSocketClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      sendSocketMessage(socket, {
        type: 'error',
        message: 'Invalid terminal websocket message',
      });
      return;
    }

    if (result.data.type === 'input') {
      session.process.write(result.data.data);
      this.touchSessionTtl(session);
      return;
    }

    session.process.resize(result.data.cols, result.data.rows);
    this.touchSessionTtl(session);
  }

  /**
   * Handles try auto submit password.
   */
  private tryAutoSubmitPassword(sessionId: string, outputChunk: string) {
    const session = this.sshSessions.get(sessionId);
    if (!session || session.closedAt || !session.authPassword || session.authPasswordSent) {
      return;
    }
    const detectorBuffer = `${session.authPromptBuffer ?? ''}${outputChunk}`;
    session.authPromptBuffer = detectorBuffer.slice(-256);
    if (!looksLikePasswordPrompt(session.authPromptBuffer)) {
      return;
    }

    session.process.write(`${session.authPassword}\r`);
    session.authPasswordSent = true;
    session.authPassword = undefined;
    session.authPromptBuffer = '';
    this.pushSessionOutput(session.id, '\r\n[auth] submitted provided SSH password.\r\n');
    this.logger.debug('Auto-submitted SSH password after prompt detection', {
      sessionId: session.id,
      hostId: session.hostId,
    });
  }

  /**
   * Handles mark attached.
   */
  private markAttached(session: SshSession, actorUserId: string, transport: 'socket' | 'stream') {
    const attachedAfterMs = session.awaitingFirstAttachSinceMs
      ? Math.max(0, Date.now() - session.awaitingFirstAttachSinceMs)
      : null;
    if (session.attachTimer) {
      clearTimeout(session.attachTimer);
      session.attachTimer = undefined;
    }
    session.awaitingFirstAttachSinceMs = undefined;
    this.logger.debug('SSH terminal attached', {
      sessionId: session.id,
      actorUserId,
      hostId: session.hostId,
      target: session.target,
      transport,
      attachedAfterMs,
    });
  }

  /**
   * Handles touch session ttl.
   */
  private touchSessionTtl(session: SshSession) {
    if (session.closedAt) {
      return;
    }
    if (session.keepalive) {
      clearTimeout(session.keepalive);
    }

    session.keepalive = setTimeout(() => {
      this.logger.info('SSH session idle timeout reached', {
        sessionId: session.id,
        hostId: session.hostId,
      });
      this.finalizeSshSession(session.id, 'idle_timeout');
    }, sessionIdleTtlMs);
  }

  /**
   * Handles push session output.
   */
  private pushSessionOutput(sessionId: string, chunk: string) {
    const session = this.sshSessions.get(sessionId);
    if (!session || !chunk) {
      return;
    }

    const trimmedChunk =
      chunk.length > maxBacklogChunkSize ? chunk.slice(0, maxBacklogChunkSize) : chunk;
    session.backlog.push(trimmedChunk);
    if (session.backlog.length > maxBacklogChunks) {
      session.backlog = session.backlog.slice(session.backlog.length - maxBacklogChunks);
    }

    for (const subscriber of session.subscribers) {
      writeSse(subscriber, 'output', { chunk: trimmedChunk });
    }
    if (session.socket) {
      sendSocketMessage(session.socket, {
        type: 'output',
        chunk: trimmedChunk,
      });
    }
    this.touchSessionTtl(session);
  }

  /**
   * Handles finalize ssh session.
   */
  private finalizeSshSession(sessionId: string, reason: string) {
    const session = this.sshSessions.get(sessionId);
    if (!session || session.closedAt) {
      return;
    }

    session.closedAt = new Date().toISOString();
    session.closedReason = reason;
    this.logger.debug('Finalizing SSH session', {
      sessionId: session.id,
      hostId: session.hostId,
      target: session.target,
      reason,
    });

    if (session.keepalive) {
      clearTimeout(session.keepalive);
      session.keepalive = undefined;
    }
    if (session.attachTimer) {
      clearTimeout(session.attachTimer);
      session.attachTimer = undefined;
    }
    session.awaitingFirstAttachSinceMs = undefined;
    session.authPassword = undefined;
    session.authPasswordSent = undefined;
    session.authPromptBuffer = undefined;
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = undefined;
    }

    if (!session.processExited) {
      try {
        session.process.kill();
      } catch {
        // Best-effort process cleanup.
      }
    }

    for (const subscriber of session.subscribers) {
      writeSse(subscriber, 'close', {
        sessionId: session.id,
        closedAt: session.closedAt,
        reason,
      });
      subscriber.end();
    }
    session.subscribers.clear();

    if (session.socket) {
      sendSocketMessage(session.socket, {
        type: 'close',
        closedAt: session.closedAt,
        reason,
        sessionId: session.id,
      });
      closeSocket(session.socket, 1000, reason);
      session.socket = undefined;
    }

    session.cleanupTimer = setTimeout(() => {
      const existing = this.sshSessions.get(sessionId);
      if (!existing || !existing.closedAt) {
        return;
      }
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
        existing.cleanupTimer = undefined;
      }
      this.sshSessions.delete(sessionId);
      this.logger.trace('Expired closed SSH session from retention map', {
        sessionId,
      });
    }, sessionClosedRetentionMs);
  }

  /**
   * Handles arm first attach timeout.
   */
  private armFirstAttachTimeout(session: SshSession) {
    if (session.attachTimer) {
      clearTimeout(session.attachTimer);
      session.attachTimer = undefined;
    }
    session.attachTimer = setTimeout(() => {
      const current = this.sshSessions.get(session.id);
      if (!current || current.closedAt || current.subscribers.size > 0 || current.socket) {
        return;
      }
      this.logger.warn('SSH session timed out before first interactive attachment', {
        sessionId: current.id,
        hostId: current.hostId,
        target: current.target,
      });
      this.pushSessionOutput(
        current.id,
        '\r\n[terminal attach timeout] Browser did not attach terminal in time.\r\n',
      );
      this.finalizeSshSession(current.id, 'attach_timeout');
    }, sessionAttachTimeoutMs);
  }

  /**
   * Gets owned session.
   */
  private getOwnedSession(sessionId: string, actorUserId: string) {
    const session = this.sshSessions.get(sessionId);
    if (!session) {
      throw new NotFoundException('SSH session not found');
    }
    if (session.ownerUserId !== actorUserId) {
      throw new NotFoundException('SSH session not found');
    }
    return session;
  }
}

/**
 * Implements read output.
 */
function readOutput(result: Record<string, unknown> | null) {
  if (!result) {
    return '';
  }

  const output = result.output;
  if (typeof output === 'string') {
    return output;
  }

  return JSON.stringify(result, null, 2);
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

/**
 * Implements write sse.
 */
function writeSse(response: Response, eventType: string, payload: Record<string, unknown>) {
  response.write(`event: ${eventType}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Implements send socket message.
 */
function sendSocketMessage(socket: WebSocket, payload: TerminalSshSocketServerMessage) {
  if (socket.readyState !== websocketOpenState) {
    return;
  }
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // Best-effort websocket send.
  }
}

/**
 * Implements close socket.
 */
function closeSocket(socket: WebSocket, code: number, reason: string) {
  try {
    socket.close(code, reason.slice(0, 120));
  } catch {
    // Best-effort websocket close.
  }
}

/**
 * Implements raw socket message to string.
 */
function rawSocketMessageToString(raw: unknown) {
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw instanceof Buffer) {
    return raw.toString('utf8');
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(
      raw.map((entry) => (entry instanceof Buffer ? entry : Buffer.from(entry))),
    ).toString('utf8');
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString('utf8');
  }
  return String(raw);
}

/**
 * Implements sanitize ssh username.
 */
function sanitizeSshUsername(raw: string) {
  const trimmed = raw.trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(trimmed)) {
    throw new BadRequestException('Invalid SSH username');
  }
  return trimmed;
}

/**
 * Implements normalize port.
 */
function normalizePort(value: number | undefined) {
  if (value === undefined) {
    return 22;
  }
  if (!Number.isFinite(value) || value < 1 || value > 65535) {
    throw new BadRequestException('Invalid SSH port');
  }
  return Math.round(value);
}

/**
 * Checks whether safe ssh target.
 */
function isSafeSshTarget(target: string) {
  const trimmed = target.trim();
  if (!trimmed) {
    return false;
  }

  return /^[a-zA-Z0-9.-]{1,255}$/.test(trimmed);
}

/**
 * Implements extract host ip.
 */
function extractHostIp(snapshotValue: unknown): string | null {
  const snapshot = toRecord(snapshotValue);
  const network = toRecord(snapshot?.network);
  const direct = readString(network, ['primaryIp', 'ip', 'address']);
  if (direct) {
    return direct;
  }

  const interfaces = Array.isArray(network?.interfaces)
    ? network.interfaces
    : Array.isArray(network?.ifaces)
      ? network.ifaces
      : Array.isArray(network?.adapters)
        ? network.adapters
        : [];

  for (const entry of interfaces) {
    const record = toRecord(entry);
    const candidate = readString(record, ['ipv4', 'ip', 'address']);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

/**
 * Implements read string.
 */
function readString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
}

/**
 * Implements extract host from endpoint.
 */
function extractHostFromEndpoint(endpoint: unknown): string | null {
  if (typeof endpoint !== 'string') {
    return null;
  }
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

/**
 * Implements normalize ssh password.
 */
function normalizeSshPassword(value: string | undefined) {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value.length === 0) {
    return undefined;
  }
  return value;
}

/**
 * Implements looks like password prompt.
 */
function looksLikePasswordPrompt(chunk: string) {
  if (!chunk) {
    return false;
  }
  return /\b(?:password|passphrase)\b[^:\n\r]{0,48}:/i.test(chunk);
}
