/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the checks service ai monitor draft test behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChecksService } from '../src/modules/checks/checks.service';

describe('ChecksService AI monitor draft sanitization', () => {
  const prisma = {
    host: {
      findMany: vi.fn(),
    },
    service: {
      findMany: vi.fn(),
    },
    check: {
      findMany: vi.fn(),
    },
    alertEvent: {
      findMany: vi.fn(),
    },
    event: {
      findMany: vi.fn(),
    },
    opsMemory: {
      findUnique: vi.fn(),
    },
  };

  const eventsService = {
    emit: vi.fn(),
  };

  const auditService = {
    write: vi.fn(),
  };

  const aiProviderService = {
    getClient: vi.fn(),
    getModel: vi.fn(() => 'gpt-5-mini'),
  };

  let service: ChecksService;

  beforeEach(() => {
    vi.clearAllMocks();

    prisma.host.findMany.mockResolvedValue([]);
    prisma.service.findMany.mockResolvedValue([]);
    prisma.check.findMany.mockResolvedValue([]);
    prisma.alertEvent.findMany.mockResolvedValue([]);
    prisma.event.findMany.mockResolvedValue([]);
    prisma.opsMemory.findUnique.mockResolvedValue(null);

    service = new ChecksService(
      prisma as never,
      eventsService as never,
      auditService as never,
      aiProviderService as never,
    );
  });

  it('drops placeholder keyword from AI parse monitor responses', async () => {
    aiProviderService.getClient.mockResolvedValueOnce({
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({
            name: 'Pi-hole 192.168.3.15 admin',
            type: 'HTTP',
            target: 'http://192.168.3.15/admin',
            expectedStatus: 200,
            intervalSec: 60,
            timeoutMs: 2000,
            keyword: 'optional',
            enabled: true,
          }),
        }),
      },
    });

    const response = await service.parseMonitorDescription('user-1', {
      description: 'Monitor Pi-hole admin on 192.168.3.15',
    });

    expect(response.generatedByAi).toBe(true);
    expect(response.monitor.keyword).toBeUndefined();
  });

  it('drops placeholder keyword from AI monitor suggestions', async () => {
    aiProviderService.getClient.mockResolvedValueOnce({
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({
            suggestions: [
              {
                name: 'Pi-hole admin',
                type: 'HTTP',
                target: 'http://192.168.3.15/admin/',
                expectedStatus: 200,
                intervalSec: 60,
                timeoutMs: 2000,
                keyword: 'N/A',
                enabled: true,
              },
            ],
          }),
        }),
      },
    });

    const response = await service.suggestMonitors('user-1');

    expect(response.generatedByAi).toBe(true);
    expect(response.suggestions).toHaveLength(1);
    expect(response.suggestions[0]?.keyword).toBeUndefined();
  });

  it('keeps meaningful keyword from AI parse monitor responses', async () => {
    aiProviderService.getClient.mockResolvedValueOnce({
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({
            name: 'Pi-hole login page',
            type: 'HTTP',
            target: 'http://192.168.3.15/admin/',
            expectedStatus: 200,
            intervalSec: 60,
            timeoutMs: 2000,
            keyword: 'Pi-hole',
            enabled: true,
          }),
        }),
      },
    });

    const response = await service.parseMonitorDescription('user-1', {
      description: 'Monitor Pi-hole login page',
    });

    expect(response.generatedByAi).toBe(true);
    expect(response.monitor.keyword).toBe('Pi-hole');
  });
});
