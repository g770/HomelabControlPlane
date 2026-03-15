/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the ai provider service test behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiProviderService } from '../src/modules/ai/ai-provider.service';

describe('AiProviderService', () => {
  const prisma = {
    user: {
      findUnique: vi.fn(),
    },
    opsMemory: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  };
  const configService = {
    get: vi.fn((key: string, fallback?: unknown) => {
      if (key === 'OPENAI_MODEL') {
        return 'gpt-5-mini';
      }
      return fallback;
    }),
  };
  const securityService = {
    encryptJson: vi.fn(),
    decryptJson: vi.fn(),
  };
  const auditService = {
    write: vi.fn(),
  };

  let service: AiProviderService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({
      id: 'local-admin-id',
    });
    service = new AiProviderService(
      prisma as never,
      configService as never,
      securityService as never,
      auditService as never,
    );
  });

  it('returns safe provider metadata without exposing the stored key', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce({
      id: 'memory-1',
      value: {
        apiKeyEncrypted: 'encrypted-key',
      },
      updatedAt: new Date('2026-03-14T03:00:00.000Z'),
    });

    await expect(service.getProviderConfig()).resolves.toEqual({
      configured: true,
      model: 'gpt-5-mini',
      updatedAt: '2026-03-14T03:00:00.000Z',
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'admin@local' },
      select: { id: true },
    });
  });

  it('builds an OpenAI client from the encrypted key without exposing it', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce({
      id: 'memory-1',
      value: {
        apiKeyEncrypted: 'encrypted-key',
      },
      updatedAt: new Date('2026-03-14T03:00:00.000Z'),
    });
    securityService.decryptJson.mockReturnValueOnce({
      apiKey: 'sk-live-123',
    });

    const client = await service.getClient();

    expect(client).toBeTruthy();
    expect(securityService.decryptJson).toHaveBeenCalledWith('encrypted-key');
  });

  it('stores an encrypted key under the installation admin and writes a safe audit event', async () => {
    securityService.encryptJson.mockReturnValueOnce('encrypted-key');
    prisma.opsMemory.upsert.mockResolvedValueOnce({
      id: 'memory-1',
      updatedAt: new Date('2026-03-14T03:05:00.000Z'),
    });

    await expect(service.setProviderConfig('user-1', 'sk-live-123')).resolves.toEqual({
      configured: true,
      model: 'gpt-5-mini',
      updatedAt: '2026-03-14T03:05:00.000Z',
    });
    expect(securityService.encryptJson).toHaveBeenCalledWith({ apiKey: 'sk-live-123' });
    expect(prisma.opsMemory.upsert).toHaveBeenCalledWith({
      where: {
        userId_key: {
          userId: 'local-admin-id',
          key: 'ai_provider_v1',
        },
      },
      update: {
        value: {
          apiKeyEncrypted: 'encrypted-key',
        },
      },
      create: {
        userId: 'local-admin-id',
        key: 'ai_provider_v1',
        value: {
          apiKeyEncrypted: 'encrypted-key',
        },
      },
    });
    expect(auditService.write).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      action: 'ai.provider.update',
      targetType: 'ops_memory',
      targetId: 'memory-1',
      paramsJson: {
        configured: true,
      },
      success: true,
    });
    expect(JSON.stringify(auditService.write.mock.calls[0]?.[0])).not.toContain('sk-live-123');
  });

  it('clears the configured key without writing secret material', async () => {
    prisma.opsMemory.upsert.mockResolvedValueOnce({
      id: 'memory-1',
      updatedAt: new Date('2026-03-14T03:10:00.000Z'),
    });

    await expect(service.setProviderConfig('user-1', null)).resolves.toEqual({
      configured: false,
      model: 'gpt-5-mini',
      updatedAt: '2026-03-14T03:10:00.000Z',
    });
    expect(securityService.encryptJson).not.toHaveBeenCalled();
    expect(auditService.write).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      action: 'ai.provider.update',
      targetType: 'ops_memory',
      targetId: 'memory-1',
      paramsJson: {
        configured: false,
      },
      success: true,
    });
  });

  it('reports unconfigured status when the installation admin is missing', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);

    await expect(service.getProviderConfig()).resolves.toEqual({
      configured: false,
      model: 'gpt-5-mini',
      updatedAt: null,
    });
    await expect(service.isConfigured()).resolves.toBe(false);
  });
});
