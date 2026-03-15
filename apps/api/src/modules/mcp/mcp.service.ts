/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements mcp service business logic for the service layer.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { WRITE_TOOLS } from '@homelab/shared';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { SecurityService } from '../common/security.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
/**
 * Implements the mcp service class.
 */
export class McpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly securityService: SecurityService,
  ) {}

  async callTool(params: {
    actorUserId?: string;
    agentId: string;
    toolName: string;
    toolParams: Record<string, unknown>;
    allowWrite?: boolean;
  }) {
    if (WRITE_TOOLS.has(params.toolName) && !params.allowWrite) {
      throw new ForbiddenException('Write tools require explicit approval flow');
    }

    const agent = await this.prisma.agent.findUnique({ where: { id: params.agentId } });
    if (!agent || agent.revokedAt) {
      throw new NotFoundException('Agent not found');
    }

    const token = this.securityService.decryptJson<{ token: string }>(agent.tokenEncrypted).token;

    const body = {
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/call',
      params: {
        name: params.toolName,
        arguments: params.toolParams,
      },
    };

    let responsePayload: Record<string, unknown> | undefined;
    let statusCode: number | undefined;
    let responseBodySnippet: string | undefined;
    let responseParseError: string | undefined;
    let durationMs = 0;
    let causeCode: string | null = null;
    let causeMessage: string | null = null;
    const startedAt = Date.now();

    try {
      const response = await fetch(agent.mcpEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      durationMs = Date.now() - startedAt;
      statusCode = response.status;

      const rawBody = await response.text();
      responseBodySnippet = summarizeBody(rawBody);
      if (rawBody.trim().length > 0) {
        try {
          const parsed = JSON.parse(rawBody) as unknown;
          const parsedRecord = toRecord(parsed);
          if (parsedRecord) {
            responsePayload = parsedRecord;
          } else {
            responseParseError = 'response was valid JSON but not an object';
          }
        } catch (error) {
          responseParseError = error instanceof Error ? error.message : 'invalid json';
        }
      }

      if (!response.ok) {
        throw new BadRequestException(
          buildHttpErrorMessage(response.status, responsePayload, responseBodySnippet),
        );
      }

      if (!responsePayload) {
        throw new BadRequestException('MCP call failed: invalid JSON response from agent');
      }

      if (responsePayload.error) {
        throw new BadRequestException(`MCP call failed: ${JSON.stringify(responsePayload.error)}`);
      }

      await this.auditService.write({
        actorUserId: params.actorUserId,
        action: 'mcp.tool.call',
        targetType: 'agent',
        targetId: params.agentId,
        paramsJson: {
          tool: params.toolName,
          params: params.toolParams,
        } as Prisma.InputJsonValue,
        resultJson: {
          ok: true,
          statusCode,
          durationMs,
        } as Prisma.InputJsonValue,
        success: true,
      });

      return responsePayload;
    } catch (error) {
      durationMs = durationMs > 0 ? durationMs : Date.now() - startedAt;
      let loggedError = error instanceof Error ? error : new Error('Unknown MCP error');
      if (!(error instanceof BadRequestException)) {
        const transport = describeTransportError(error);
        causeCode = transport.code;
        causeMessage = transport.message;
        loggedError = new BadRequestException(
          buildTransportErrorMessage(agent.mcpEndpoint, params.toolName, durationMs, transport),
        );
      }

      await this.auditService.write({
        actorUserId: params.actorUserId,
        action: 'mcp.tool.call',
        targetType: 'agent',
        targetId: params.agentId,
        paramsJson: {
          tool: params.toolName,
          params: params.toolParams,
        } as Prisma.InputJsonValue,
        resultJson: {
          error: loggedError.message,
          statusCode,
          parseError: responseParseError ?? null,
          bodySnippet: responseBodySnippet ?? null,
          payload: responsePayload,
          durationMs,
          causeCode,
          causeMessage,
        } as Prisma.InputJsonValue,
        success: false,
      });

      throw loggedError;
    }
  }
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
 * Implements summarize body.
 */
function summarizeBody(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
}

/**
 * Builds http error message.
 */
function buildHttpErrorMessage(
  statusCode: number,
  payload: Record<string, unknown> | undefined,
  bodySnippet: string | undefined,
) {
  if (statusCode === 401 || statusCode === 403) {
    return `MCP authentication failed (HTTP ${statusCode}). Re-enroll agent or refresh agent credentials.`;
  }

  const payloadError = payload?.error;
  if (payloadError) {
    return `MCP call failed with HTTP ${statusCode}: ${JSON.stringify(payloadError)}`;
  }

  if (bodySnippet && bodySnippet.length > 0) {
    return `MCP call failed with HTTP ${statusCode}: ${bodySnippet}`;
  }

  return `MCP call failed with HTTP ${statusCode}`;
}

/**
 * Builds transport error message.
 */
function buildTransportErrorMessage(
  endpoint: string,
  toolName: string,
  durationMs: number,
  transport: { code: string | null; message: string | null },
) {
  const segments = [
    `MCP transport failed while calling ${toolName} via ${endpoint} after ${durationMs}ms`,
  ];
  if (transport.code) {
    segments.push(`(${transport.code})`);
  }
  if (transport.message) {
    segments.push(`: ${transport.message}`);
  }
  return segments.join('');
}

/**
 * Implements describe transport error.
 */
function describeTransportError(error: unknown) {
  const errorRecord = toRecord(error);
  const causeRecord = toRecord(errorRecord?.cause);
  const topLevelCode = readErrorString(errorRecord, 'code');
  const causeCode = readErrorString(causeRecord, 'code') ?? readErrorString(causeRecord, 'errno');
  const topLevelMessage =
    error instanceof Error ? error.message : readErrorString(errorRecord, 'message');
  const nestedCauseMessage =
    readErrorString(causeRecord, 'message') ?? readErrorString(causeRecord, 'cause');

  return {
    code: causeCode ?? topLevelCode ?? null,
    message: nestedCauseMessage ?? topLevelMessage ?? 'unknown transport error',
  };
}

/**
 * Implements read error string.
 */
function readErrorString(source: Record<string, unknown> | null, key: string) {
  const value = source?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
