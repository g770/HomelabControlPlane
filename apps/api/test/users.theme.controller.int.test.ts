/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the users theme controller int test behavior.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { defaultSidebarNavigationOrderedItemIds } from '@homelab/shared';
import { UsersController } from '../src/modules/users/users.controller';
import { UsersService } from '../src/modules/users/users.service';

describe('UsersController theme endpoints (integration)', () => {
  let app: NestFastifyApplication;
  let currentUser: { sub: string; email: string; displayName: string };

  const usersServiceMock = {
    getTheme: vi.fn(),
    updateTheme: vi.fn(),
    getPreferences: vi.fn(),
    updateHiddenHosts: vi.fn(),
    updateDashboardOrphanRecoveryNotice: vi.fn(),
    updateSidebarNavigation: vi.fn(),
  };

  @Module({
    controllers: [UsersController],
    providers: [
      {
        provide: UsersService,
        useValue: usersServiceMock,
      },
    ],
  })
  class TestUsersThemeModule {}

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestUsersThemeModule],
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

  /**
   * Builds preferences response.
   */
  function buildPreferencesResponse() {
    return {
      preferences: {
        hiddenHostIds: ['d8ef4d73-c886-43cb-a6af-3eeb587f66af'],
        discoverySubnets: ['192.168.1.0/24'],
        hostListColumns: {
          hiddenColumnIds: [],
          widths: [],
        },
        dashboardSuggestionsNotice: {
          dismissedFingerprint: null,
        },
        dashboardOrphanRecoveryNotice: {
          dismissedFingerprint: null,
        },
        sidebarNavigation: {
          orderedItemIds: defaultSidebarNavigationOrderedItemIds.slice(),
        },
      },
      updatedAt: '2026-02-21T14:00:00.000Z',
    };
  }

  it('GET /api/account/theme returns current user theme', async () => {
    usersServiceMock.getTheme.mockResolvedValueOnce({
      theme: { preset: 'default', mode: 'dark', palette: 'ocean', style: 'soft' },
      isCustom: false,
      updatedAt: null,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/account/theme',
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode, response.body).toBe(200);
    expect(usersServiceMock.getTheme).toHaveBeenCalledWith('user-123');
    expect(body).toMatchObject({
      theme: { preset: 'default', mode: 'dark', palette: 'ocean', style: 'soft' },
      isCustom: false,
    });
  });

  it('PUT /api/account/theme validates explicit confirmation and forwards payload', async () => {
    usersServiceMock.updateTheme.mockResolvedValueOnce({
      theme: { preset: 'neon-grid', mode: 'light', palette: 'neon-grid', style: 'grid' },
      isCustom: true,
      updatedAt: '2026-02-20T16:00:00.000Z',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/account/theme',
      payload: {
        confirm: true,
        theme: { preset: 'neon-grid', mode: 'light', palette: 'neon-grid', style: 'grid' },
      },
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode, response.body).toBe(200);
    expect(usersServiceMock.updateTheme).toHaveBeenCalledWith('user-123', {
      preset: 'neon-grid',
      mode: 'light',
      palette: 'neon-grid',
      style: 'grid',
    });
    expect(body).toMatchObject({
      theme: { preset: 'neon-grid', mode: 'light', palette: 'neon-grid', style: 'grid' },
      isCustom: true,
    });
  });

  it('PUT /api/account/theme rejects invalid payloads', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/account/theme',
      payload: {
        theme: { preset: 'neon-grid', mode: 'light', palette: 'neon-grid', style: 'grid' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(usersServiceMock.updateTheme).not.toHaveBeenCalled();
  });

  it('GET /api/account/preferences returns hidden-host settings', async () => {
    usersServiceMock.getPreferences.mockResolvedValueOnce(buildPreferencesResponse());

    const response = await app.inject({
      method: 'GET',
      url: '/api/account/preferences',
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode, response.body).toBe(200);
    expect(usersServiceMock.getPreferences).toHaveBeenCalledWith('user-123');
    expect(body).toMatchObject({
      preferences: {
        hiddenHostIds: ['d8ef4d73-c886-43cb-a6af-3eeb587f66af'],
      },
    });
  });

  it('PUT /api/account/preferences/hidden-hosts validates confirmation and forwards ids', async () => {
    usersServiceMock.updateHiddenHosts.mockResolvedValueOnce(buildPreferencesResponse());

    const response = await app.inject({
      method: 'PUT',
      url: '/api/account/preferences/hidden-hosts',
      payload: {
        confirm: true,
        hiddenHostIds: ['d8ef4d73-c886-43cb-a6af-3eeb587f66af'],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(usersServiceMock.updateHiddenHosts).toHaveBeenCalledWith('user-123', [
      'd8ef4d73-c886-43cb-a6af-3eeb587f66af',
    ]);
  });

  it('PUT /api/account/preferences/sidebar-navigation validates confirmation and forwards ordered ids', async () => {
    usersServiceMock.updateSidebarNavigation.mockResolvedValueOnce(buildPreferencesResponse());

    const response = await app.inject({
      method: 'PUT',
      url: '/api/account/preferences/sidebar-navigation',
      payload: {
        confirm: true,
        orderedItemIds: [
          'dashboard',
          'dashboard-agent',
          'hosts',
          'network-monitors',
          'alerts',
          'service-discovery',
          'agent-management',
          'ai',
          'settings',
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(usersServiceMock.updateSidebarNavigation).toHaveBeenCalledWith('user-123', [
      'dashboard',
      'dashboard-agent',
      'hosts',
      'network-monitors',
      'alerts',
      'service-discovery',
      'agent-management',
      'ai',
      'settings',
    ]);
  });

  it('PUT /api/account/preferences/dashboard-orphan-recovery-notice validates confirmation and forwards the fingerprint', async () => {
    usersServiceMock.updateDashboardOrphanRecoveryNotice.mockResolvedValueOnce(
      buildPreferencesResponse(),
    );

    const response = await app.inject({
      method: 'PUT',
      url: '/api/account/preferences/dashboard-orphan-recovery-notice',
      payload: {
        confirm: true,
        dismissedFingerprint: 'fnv1a-orphan-a',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(usersServiceMock.updateDashboardOrphanRecoveryNotice).toHaveBeenCalledWith(
      'user-123',
      'fnv1a-orphan-a',
    );
  });

  it('PUT /api/account/preferences/sidebar-navigation rejects invalid payloads', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/account/preferences/sidebar-navigation',
      payload: {
        orderedItemIds: ['dashboard', 'settings'],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(usersServiceMock.updateSidebarNavigation).not.toHaveBeenCalled();
  });
});
