/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the mcp service test behavior.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpService } from '../src/modules/mcp/mcp.service';

describe('McpService.callTool', () => {
  const prisma = {
    agent: {
      findUnique: vi.fn(),
    },
  };
  const auditService = {
    write: vi.fn(),
  };
  const securityService = {
    decryptJson: vi.fn(),
  };

  let service: McpService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new McpService(prisma as any, auditService as any, securityService as any);
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      revokedAt: null,
      mcpEndpoint: 'http://agent.example.local/mcp',
      tokenEncrypted: 'encrypted-token',
    });
    securityService.decryptJson.mockReturnValue({
      token: 'agent-token',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects write tools unless explicit allowWrite is set', async () => {
    await expect(
      service.callTool({
        agentId: 'agent-1',
        toolName: 'services.restart',
        toolParams: { name: 'nginx' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws NotFound when agent does not exist', async () => {
    prisma.agent.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.callTool({
        agentId: 'missing-agent',
        toolName: 'host.status',
        toolParams: {},
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('normalizes non-json unauthorized responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized\n', { status: 401 })),
    );

    const error = await service
      .callTool({
        agentId: 'agent-1',
        toolName: 'host.status',
        toolParams: {},
      })
      .catch((caught) => caught as Error);
    expect(error).toBeInstanceOf(BadRequestException);
    if (!(error instanceof Error)) {
      throw new Error('Expected an Error instance');
    }
    expect(error.message.toLowerCase()).toContain('authentication failed');
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp.tool.call',
        success: false,
      }),
    );
  });

  it('returns parsed json payload for successful responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { ok: true } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const result = await service.callTool({
      agentId: 'agent-1',
      toolName: 'host.status',
      toolParams: {},
    });

    expect(result).toEqual({
      jsonrpc: '2.0',
      id: '1',
      result: { ok: true },
    });
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp.tool.call',
        resultJson: expect.objectContaining({
          durationMs: expect.any(Number),
        }),
        success: true,
      }),
    );
  });

  it('captures transport cause details for fetch failures', async () => {
    const transportError = new TypeError('fetch failed');
    (transportError as TypeError & { cause?: unknown }).cause = {
      code: 'UND_ERR_HEADERS_TIMEOUT',
      message: 'Headers Timeout Error',
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw transportError;
      }),
    );

    const error = await service
      .callTool({
        agentId: 'agent-1',
        toolName: 'network.scan_known_services.start',
        toolParams: {},
      })
      .catch((caught) => caught as Error);

    expect(error).toBeInstanceOf(BadRequestException);
    if (!(error instanceof Error)) {
      throw new Error('Expected an Error instance');
    }
    expect(error.message).toContain('MCP transport failed');
    expect(error.message).toContain('UND_ERR_HEADERS_TIMEOUT');
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp.tool.call',
        resultJson: expect.objectContaining({
          error: expect.stringContaining('MCP transport failed'),
          causeCode: 'UND_ERR_HEADERS_TIMEOUT',
          causeMessage: 'Headers Timeout Error',
          durationMs: expect.any(Number),
        }),
        success: false,
      }),
    );
  });
});
