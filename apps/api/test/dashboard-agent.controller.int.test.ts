/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the dashboard agent controller int test behavior.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DashboardAgentController } from '../src/modules/dashboard-agent/dashboard-agent.controller';
import { DashboardAgentService } from '../src/modules/dashboard-agent/dashboard-agent.service';

describe('DashboardAgentController (integration)', () => {
  let app: NestFastifyApplication;
  let currentUser: { sub: string; email: string; displayName: string };

  const dashboardAgentServiceMock = {
    getStatus: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    deleteRun: vi.fn(),
    getHighlights: vi.fn(),
    triggerManualRun: vi.fn(),
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
  };

  @Module({
    controllers: [DashboardAgentController],
    providers: [
      {
        provide: DashboardAgentService,
        useValue: dashboardAgentServiceMock,
      },
    ],
  })
  class TestDashboardAgentModule {}

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestDashboardAgentModule],
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
      sub: 'user-1',
      email: 'admin@local',
      displayName: 'Admin',
    };
  });

  it('GET /api/dashboard-agent/status returns the current run status for the authenticated admin', async () => {
    dashboardAgentServiceMock.getStatus.mockResolvedValueOnce({
      enabled: true,
      intervalSec: 300,
      isRunning: false,
      nextScheduledRunAt: '2026-03-07T12:00:00.000Z',
      lastRunAt: null,
      lastRunId: null,
      lastRunStatus: null,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/dashboard-agent/status',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(dashboardAgentServiceMock.getStatus).toHaveBeenCalledTimes(1);
  });

  it('GET run endpoints always request debug payloads for the authenticated admin', async () => {
    dashboardAgentServiceMock.listRuns.mockResolvedValueOnce({
      runs: [],
    });
    dashboardAgentServiceMock.getRun.mockResolvedValueOnce({
      run: {
        id: '4b7cb21d-d0ee-413d-b2a6-ec751ab50791',
      },
    });
    dashboardAgentServiceMock.getHighlights.mockResolvedValueOnce({
      runId: null,
      status: null,
      generatedAt: null,
      highlights: [],
    });

    const runsResponse = await app.inject({
      method: 'GET',
      url: '/api/dashboard-agent/runs?limit=7',
    });
    expect(runsResponse.statusCode, runsResponse.body).toBe(200);
    expect(dashboardAgentServiceMock.listRuns).toHaveBeenCalledWith(7, {
      includeDebug: true,
    });

    const runResponse = await app.inject({
      method: 'GET',
      url: '/api/dashboard-agent/runs/4b7cb21d-d0ee-413d-b2a6-ec751ab50791',
    });
    expect(runResponse.statusCode, runResponse.body).toBe(200);
    expect(dashboardAgentServiceMock.getRun).toHaveBeenCalledWith(
      '4b7cb21d-d0ee-413d-b2a6-ec751ab50791',
      {
        includeDebug: true,
      },
    );

    const highlightsResponse = await app.inject({
      method: 'GET',
      url: '/api/dashboard-agent/highlights',
    });
    expect(highlightsResponse.statusCode, highlightsResponse.body).toBe(200);
    expect(dashboardAgentServiceMock.getHighlights).toHaveBeenCalledTimes(1);
  });

  it('DELETE /api/dashboard-agent/runs/:id validates confirm and calls service', async () => {
    currentUser = {
      sub: 'user-7',
      email: 'admin@local',
      displayName: 'Admin',
    };
    dashboardAgentServiceMock.deleteRun.mockResolvedValueOnce({
      ok: true,
      deleted: true,
      runId: '4b7cb21d-d0ee-413d-b2a6-ec751ab50791',
    });

    const invalid = await app.inject({
      method: 'DELETE',
      url: '/api/dashboard-agent/runs/4b7cb21d-d0ee-413d-b2a6-ec751ab50791',
      payload: {
        confirm: false,
      },
    });
    expect(invalid.statusCode).toBe(400);

    const valid = await app.inject({
      method: 'DELETE',
      url: '/api/dashboard-agent/runs/4b7cb21d-d0ee-413d-b2a6-ec751ab50791',
      payload: {
        confirm: true,
      },
    });
    expect(valid.statusCode, valid.body).toBe(200);
    expect(dashboardAgentServiceMock.deleteRun).toHaveBeenCalledWith(
      '4b7cb21d-d0ee-413d-b2a6-ec751ab50791',
      'user-7',
    );
  });

  it('POST /api/dashboard-agent/run validates confirm and calls service', async () => {
    dashboardAgentServiceMock.triggerManualRun.mockResolvedValueOnce({
      id: '4b7cb21d-d0ee-413d-b2a6-ec751ab50791',
      status: 'COMPLETED',
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/run',
      payload: {
        confirm: false,
      },
    });
    expect(invalid.statusCode).toBe(400);

    const valid = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/run',
      payload: {
        confirm: true,
      },
    });
    expect(valid.statusCode, valid.body).toBe(201);
    expect(dashboardAgentServiceMock.triggerManualRun).toHaveBeenCalledWith('user-1');
  });

  it('GET/PUT config validates payloads and forwards updates for the authenticated admin', async () => {
    dashboardAgentServiceMock.getConfig.mockResolvedValueOnce({
      config: {
        enabled: true,
        intervalSec: 300,
        escalateCreateEvents: true,
        personality: '',
      },
      defaultPersonality: 'default',
      nextScheduledRunAt: '2026-03-07T12:00:00.000Z',
      lastRunAt: null,
      isRunning: false,
      updatedAt: '2026-03-07T11:00:00.000Z',
    });

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/dashboard-agent/config',
    });
    expect(getResponse.statusCode, getResponse.body).toBe(200);
    currentUser = {
      sub: 'user-2',
      email: 'admin@local',
      displayName: 'Admin',
    };
    dashboardAgentServiceMock.updateConfig.mockResolvedValueOnce({
      config: {
        enabled: true,
        intervalSec: 300,
        escalateCreateEvents: false,
        personality: 'Focus on network issues first.',
      },
      defaultPersonality: 'default',
      nextScheduledRunAt: '2026-03-07T12:00:00.000Z',
      lastRunAt: null,
      isRunning: false,
      updatedAt: '2026-03-07T11:00:00.000Z',
    });

    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/dashboard-agent/config',
      payload: {
        confirm: false,
      },
    });
    expect(invalid.statusCode).toBe(400);

    const valid = await app.inject({
      method: 'PUT',
      url: '/api/dashboard-agent/config',
      payload: {
        confirm: true,
        config: {
          enabled: true,
          intervalSec: 300,
          escalateCreateEvents: false,
          personality: 'Focus on network issues first.',
        },
      },
    });

    expect(valid.statusCode, valid.body).toBe(200);
    expect(dashboardAgentServiceMock.updateConfig).toHaveBeenCalledWith('user-2', {
      enabled: true,
      intervalSec: 300,
      escalateCreateEvents: false,
      personality: 'Focus on network issues first.',
    });
  });
});
