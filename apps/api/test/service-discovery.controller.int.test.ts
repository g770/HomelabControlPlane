/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the service discovery controller int test behavior.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ServiceDiscoveryController } from '../src/modules/service-discovery/service-discovery.controller';
import { ServiceDiscoveryService } from '../src/modules/service-discovery/service-discovery.service';

describe('ServiceDiscoveryController (integration)', () => {
  let app: NestFastifyApplication;
  let currentUser: { sub: string; email: string; displayName: string };

  const serviceDiscoveryServiceMock = {
    triggerManualRun: vi.fn(),
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    listRuns: vi.fn(),
    deleteRun: vi.fn(),
    getEffectiveCatalog: vi.fn(),
  };

  @Module({
    controllers: [ServiceDiscoveryController],
    providers: [
      {
        provide: ServiceDiscoveryService,
        useValue: serviceDiscoveryServiceMock,
      },
    ],
  })
  class TestServiceDiscoveryModule {}

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestServiceDiscoveryModule],
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
      sub: 'user-123',
      email: 'admin@local',
      displayName: 'Admin',
    };
  });

  it('POST /api/discovery/services/run enforces explicit confirm and calls service', async () => {
    serviceDiscoveryServiceMock.triggerManualRun.mockResolvedValueOnce({
      runId: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
      status: 'COMPLETED',
      startedAt: '2026-02-21T12:00:00.000Z',
      finishedAt: '2026-02-21T12:00:02.000Z',
      trigger: 'MANUAL',
      summary: {
        hostCount: 1,
        probeCount: 2,
        detectedCount: 1,
        upsertCount: 1,
        errors: 0,
      },
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/discovery/services/run',
      payload: {
        confirm: false,
      },
    });
    expect(invalid.statusCode).toBe(400);

    const response = await app.inject({
      method: 'POST',
      url: '/api/discovery/services/run',
      payload: {
        confirm: true,
        hostId: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(serviceDiscoveryServiceMock.triggerManualRun).toHaveBeenCalledWith('user-123', {
      hostId: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
    });
  });

  it('GET /api/discovery/services/config returns discovery config for the authenticated admin', async () => {
    serviceDiscoveryServiceMock.getConfig.mockResolvedValueOnce({
      config: {
        enabled: true,
        cidrs: ['192.168.1.0/24'],
        includeAutoLocalCidrs: false,
        includeCommonWebPorts: true,
        maxHosts: 256,
        concurrency: 24,
        connectTimeoutMs: 750,
        toolCallTimeoutMs: 120000,
      },
      intervalSec: 600,
      nextScheduledRunAt: '2026-02-21T18:00:00.000Z',
      lastRunAt: null,
      isRunning: false,
      updatedAt: '2026-02-21T12:00:00.000Z',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/discovery/services/config',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(serviceDiscoveryServiceMock.getConfig).toHaveBeenCalledTimes(1);
  });

  it('PUT /api/discovery/services/config validates payload and calls service', async () => {
    serviceDiscoveryServiceMock.updateConfig.mockResolvedValueOnce({
      config: {
        enabled: true,
        cidrs: ['192.168.1.0/24'],
        includeAutoLocalCidrs: false,
        includeCommonWebPorts: true,
        maxHosts: 256,
        concurrency: 24,
        connectTimeoutMs: 750,
        toolCallTimeoutMs: 120000,
      },
      intervalSec: 600,
      nextScheduledRunAt: '2026-02-21T18:00:00.000Z',
      lastRunAt: null,
      isRunning: false,
      updatedAt: '2026-02-21T12:00:00.000Z',
    });

    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/discovery/services/config',
      payload: {
        confirm: false,
      },
    });
    expect(invalid.statusCode).toBe(400);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/discovery/services/config',
      payload: {
        confirm: true,
        config: {
          enabled: true,
          cidrs: ['192.168.1.0/24'],
          includeAutoLocalCidrs: false,
          includeCommonWebPorts: true,
          maxHosts: 256,
          concurrency: 24,
          connectTimeoutMs: 750,
          toolCallTimeoutMs: 120000,
        },
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(serviceDiscoveryServiceMock.updateConfig).toHaveBeenCalledWith('user-123', {
      enabled: true,
      cidrs: ['192.168.1.0/24'],
      includeAutoLocalCidrs: false,
      includeCommonWebPorts: true,
      maxHosts: 256,
      concurrency: 24,
      connectTimeoutMs: 750,
      toolCallTimeoutMs: 120000,
    });
  });

  it('GET discovery runs and catalog returns read data for the authenticated admin', async () => {
    serviceDiscoveryServiceMock.listRuns.mockResolvedValueOnce({
      runs: [],
    });
    serviceDiscoveryServiceMock.getEffectiveCatalog.mockResolvedValueOnce({
      id: 'global',
      source: 'BUILTIN',
      expiresAt: '2026-02-21T18:00:00.000Z',
      lastError: null,
      serviceCount: 0,
      services: [],
    });

    const runs = await app.inject({
      method: 'GET',
      url: '/api/discovery/services/runs?limit=10',
    });
    expect(runs.statusCode, runs.body).toBe(200);
    expect(serviceDiscoveryServiceMock.listRuns).toHaveBeenCalledWith(10);

    const catalog = await app.inject({
      method: 'GET',
      url: '/api/discovery/services/catalog',
    });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(serviceDiscoveryServiceMock.getEffectiveCatalog).toHaveBeenCalledTimes(1);
  });

  it('DELETE /api/discovery/services/runs/:id validates confirm and calls service', async () => {
    serviceDiscoveryServiceMock.deleteRun.mockResolvedValueOnce({
      ok: true,
      deleted: true,
      runId: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
    });

    const invalid = await app.inject({
      method: 'DELETE',
      url: '/api/discovery/services/runs/f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
      payload: {
        confirm: false,
      },
    });
    expect(invalid.statusCode).toBe(400);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/discovery/services/runs/f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
      payload: {
        confirm: true,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(serviceDiscoveryServiceMock.deleteRun).toHaveBeenCalledWith(
      'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
      'user-123',
    );
  });
});
