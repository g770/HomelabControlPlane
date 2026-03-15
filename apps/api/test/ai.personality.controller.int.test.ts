/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the ai personality controller int test behavior.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AiController } from '../src/modules/ai/ai.controller';
import { AiProviderService } from '../src/modules/ai/ai-provider.service';
import { AiService } from '../src/modules/ai/ai.service';

describe('AiController personality endpoints (integration)', () => {
  let app: NestFastifyApplication;
  let currentUser: { sub: string; email: string; displayName: string };

  const aiServiceMock = {
    status: vi.fn(),
    getPersonality: vi.fn(),
    setPersonality: vi.fn(),
  };
  const aiProviderServiceMock = {
    getProviderConfig: vi.fn(),
    setProviderConfig: vi.fn(),
  };

  @Module({
    controllers: [AiController],
    providers: [
      {
        provide: AiService,
        useValue: aiServiceMock,
      },
      {
        provide: AiProviderService,
        useValue: aiProviderServiceMock,
      },
    ],
  })
  class TestAiPersonalityModule {}

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestAiPersonalityModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRequest', (request: any, _reply: any, done: () => void) => {
        request.user = currentUser;
        done();
      });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = {
      sub: 'user-456',
      email: 'admin@local',
      displayName: 'Admin',
    };
  });

  it('GET /api/ai/personality returns the active personality for the authenticated admin', async () => {
    aiServiceMock.getPersonality.mockResolvedValueOnce({
      personality: 'Be concise and operational.',
      isCustom: true,
      updatedAt: '2026-02-20T16:30:00.000Z',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/ai/personality',
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode, response.body).toBe(200);
    expect(aiServiceMock.getPersonality).toHaveBeenCalledWith('user-456');
    expect(body).toMatchObject({
      personality: 'Be concise and operational.',
      isCustom: true,
    });
  });

  it('GET /api/ai/provider returns safe provider metadata', async () => {
    aiProviderServiceMock.getProviderConfig.mockResolvedValueOnce({
      configured: true,
      model: 'gpt-5-mini',
      updatedAt: '2026-03-14T02:30:00.000Z',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/ai/provider',
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode, response.body).toBe(200);
    expect(aiProviderServiceMock.getProviderConfig).toHaveBeenCalledOnce();
    expect(body).toMatchObject({
      configured: true,
      model: 'gpt-5-mini',
    });
    expect(body).not.toHaveProperty('apiKey');
  });

  it('PUT /api/ai/provider validates confirmation and forwards the requested key update', async () => {
    aiProviderServiceMock.setProviderConfig.mockResolvedValueOnce({
      configured: true,
      model: 'gpt-5-mini',
      updatedAt: '2026-03-14T02:40:00.000Z',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/ai/provider',
      payload: {
        confirm: true,
        apiKey: 'sk-live-123',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(aiProviderServiceMock.setProviderConfig).toHaveBeenCalledWith('user-456', 'sk-live-123');
  });

  it('PUT /api/ai/personality validates confirmation and forwards payload', async () => {
    aiServiceMock.setPersonality.mockResolvedValueOnce({
      personality: 'Focus on alerts first.',
      isCustom: true,
      updatedAt: '2026-02-20T16:40:00.000Z',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/ai/personality',
      payload: {
        confirm: true,
        personality: 'Focus on alerts first.',
      },
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode, response.body).toBe(200);
    expect(aiServiceMock.setPersonality).toHaveBeenCalledWith('user-456', 'Focus on alerts first.');
    expect(body).toMatchObject({
      personality: 'Focus on alerts first.',
      isCustom: true,
    });
  });

  it('PUT /api/ai/personality rejects invalid payloads', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/ai/personality',
      payload: {
        personality: 'missing confirm should fail',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(aiServiceMock.setPersonality).not.toHaveBeenCalled();
  });

  it('PUT /api/ai/provider rejects invalid payloads', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/ai/provider',
      payload: {
        apiKey: 'missing confirm should fail',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(aiProviderServiceMock.setProviderConfig).not.toHaveBeenCalled();
  });
});
