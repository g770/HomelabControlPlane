/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the integrations controller int test behavior.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { IntegrationsController } from '../src/modules/integrations/integrations.controller';
import { IntegrationsService } from '../src/modules/integrations/integrations.service';

vi.mock('@prisma/client', () => ({
  IntegrationType: {
    PROXMOX: 'PROXMOX',
  },
}));

describe('IntegrationsController (integration)', () => {
  let app: NestFastifyApplication;
  let currentUser: { sub: string; email: string; displayName: string };
  let controller: IntegrationsController;

  const integrationsServiceMock = {
    list: vi.fn(),
    createOrUpdate: vi.fn(),
    test: vi.fn(),
    sync: vi.fn(),
    remove: vi.fn(),
  };

  @Module({
    controllers: [IntegrationsController],
    providers: [
      {
        provide: IntegrationsService,
        useValue: integrationsServiceMock,
      },
    ],
  })
  class TestIntegrationsModule {}

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestIntegrationsModule],
    }).compile();

    controller = moduleRef.get(IntegrationsController);
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
    controller = new IntegrationsController(integrationsServiceMock as never);
    currentUser = {
      sub: 'user-22',
      email: 'admin@local',
      displayName: 'Admin',
    };
  });

  it('DELETE /api/integrations/:id validates confirm before reaching the service', async () => {
    const invalid = await app.inject({
      method: 'DELETE',
      url: '/api/integrations/beee8f7d-f359-4a0f-94f6-01366ab5af39',
      payload: {
        confirm: false,
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(integrationsServiceMock.remove).not.toHaveBeenCalled();
  });

  it('POST /api/integrations validates the explicit Proxmox payload before reaching the service', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/integrations',
      payload: {
        confirm: true,
        name: 'Proxmox Lab',
        enabled: true,
        baseUrl: 'not-a-url',
        apiTokenId: '',
        apiTokenSecret: '',
        allowInsecureTls: false,
      },
    });

    expect(invalid.statusCode).toBe(400);
    expect(integrationsServiceMock.createOrUpdate).not.toHaveBeenCalled();
  });

  it('POST test/sync endpoints require explicit confirm before reaching the service', async () => {
    const invalidTest = await app.inject({
      method: 'POST',
      url: '/api/integrations/beee8f7d-f359-4a0f-94f6-01366ab5af39/test',
      payload: {
        confirm: false,
      },
    });
    expect(invalidTest.statusCode).toBe(400);
    expect(integrationsServiceMock.test).not.toHaveBeenCalled();

    const invalidSync = await app.inject({
      method: 'POST',
      url: '/api/integrations/beee8f7d-f359-4a0f-94f6-01366ab5af39/sync',
      payload: {
        confirm: false,
      },
    });
    expect(invalidSync.statusCode).toBe(400);
    expect(integrationsServiceMock.sync).not.toHaveBeenCalled();
  });

  it('delegates valid create/test/sync requests to the service', async () => {
    integrationsServiceMock.createOrUpdate.mockResolvedValueOnce({ id: 'integration-1' });
    integrationsServiceMock.test.mockResolvedValueOnce({ ok: true, details: {} });
    integrationsServiceMock.sync.mockResolvedValueOnce({ ok: true, count: 1 });

    await controller.createOrUpdate(currentUser, {
      confirm: true,
      name: 'Proxmox Lab',
      enabled: true,
      baseUrl: 'https://pve.local:8006',
      apiTokenId: 'root@pam!dashboard',
      apiTokenSecret: 'secret-token',
      allowInsecureTls: true,
    });
    await controller.test(currentUser, 'beee8f7d-f359-4a0f-94f6-01366ab5af39', { confirm: true });
    await controller.sync(currentUser, 'beee8f7d-f359-4a0f-94f6-01366ab5af39', { confirm: true });

    expect(integrationsServiceMock.createOrUpdate).toHaveBeenCalledWith('user-22', {
      confirm: true,
      name: 'Proxmox Lab',
      enabled: true,
      baseUrl: 'https://pve.local:8006',
      apiTokenId: 'root@pam!dashboard',
      apiTokenSecret: 'secret-token',
      allowInsecureTls: true,
    });
    expect(integrationsServiceMock.test).toHaveBeenCalledWith(
      'user-22',
      'beee8f7d-f359-4a0f-94f6-01366ab5af39',
    );
    expect(integrationsServiceMock.sync).toHaveBeenCalledWith(
      'user-22',
      'beee8f7d-f359-4a0f-94f6-01366ab5af39',
    );
  });
});
