/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the users service theme test behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSidebarNavigationOrderedItemIds, type SidebarNavItemId } from '@homelab/shared';
import { UsersService } from '../src/modules/users/users.service';
import { DEFAULT_UI_THEME, UI_THEME_MEMORY_KEY } from '../src/modules/users/ui-theme';

const defaultDiscoverySubnets = ['10.0.0.0/24', '172.16.0.0/24', '192.168.1.0/24'];
const defaultHostListColumns = {
  hiddenColumnIds: [],
  widths: [],
};
const defaultDashboardSuggestionsNotice = {
  dismissedFingerprint: null,
};
const defaultDashboardOrphanRecoveryNotice = {
  dismissedFingerprint: null,
};
const defaultSidebarNavigation = {
  orderedItemIds: defaultSidebarNavigationOrderedItemIds.slice(),
};

/**
 * Implements normalized sidebar navigation.
 */
function normalizedSidebarNavigation(...orderedItemIds: SidebarNavItemId[]) {
  const seen = new Set<SidebarNavItemId>();
  const normalized: SidebarNavItemId[] = [];

  for (const itemId of orderedItemIds) {
    if (seen.has(itemId)) {
      continue;
    }
    seen.add(itemId);
    normalized.push(itemId);
  }

  for (const itemId of defaultSidebarNavigationOrderedItemIds) {
    if (seen.has(itemId)) {
      continue;
    }
    normalized.push(itemId);
  }

  return {
    orderedItemIds: normalized,
  };
}

describe('UsersService theme preferences', () => {
  const prisma = {
    opsMemory: {
      findUnique: vi.fn(),
      delete: vi.fn(),
      upsert: vi.fn(),
    },
  };
  const auditService = {
    write: vi.fn(),
  };

  let service: UsersService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new UsersService(prisma as any, auditService as any);
  });

  it('returns default theme when no stored record exists', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce(null);

    const result = await service.getTheme('user-1');

    expect(result).toEqual({
      theme: DEFAULT_UI_THEME,
      isCustom: false,
      updatedAt: null,
    });
    expect(prisma.opsMemory.findUnique).toHaveBeenCalledWith({
      where: {
        userId_key: {
          userId: 'user-1',
          key: UI_THEME_MEMORY_KEY,
        },
      },
    });
  });

  it('returns custom stored theme when record exists', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce({
      id: 'mem-1',
      value: {
        preset: 'neon-grid',
        mode: 'light',
        palette: 'neon-grid',
        style: 'grid',
      },
      updatedAt: new Date('2026-02-20T12:00:00.000Z'),
    });

    const result = await service.getTheme('user-1');

    expect(result).toEqual({
      theme: {
        preset: 'neon-grid',
        mode: 'light',
        palette: 'neon-grid',
        style: 'grid',
      },
      isCustom: true,
      updatedAt: '2026-02-20T12:00:00.000Z',
    });
  });

  it('resets to default by deleting stored preference and writing audit event', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce({
      id: 'mem-2',
    });
    prisma.opsMemory.delete.mockResolvedValueOnce({});
    auditService.write.mockResolvedValueOnce({});
    const getThemeSpy = vi.spyOn(service, 'getTheme').mockResolvedValueOnce({
      theme: DEFAULT_UI_THEME,
      isCustom: false,
      updatedAt: null,
    });

    const result = await service.updateTheme('user-1', DEFAULT_UI_THEME);

    expect(prisma.opsMemory.delete).toHaveBeenCalledWith({
      where: {
        userId_key: {
          userId: 'user-1',
          key: UI_THEME_MEMORY_KEY,
        },
      },
    });
    expect(prisma.opsMemory.upsert).not.toHaveBeenCalled();
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'ui.theme.update',
        success: true,
        paramsJson: expect.objectContaining({ preset: 'default', custom: false }),
      }),
    );
    expect(getThemeSpy).toHaveBeenCalledWith('user-1');
    expect(result.theme).toEqual(DEFAULT_UI_THEME);
  });

  it('persists custom theme and returns saved metadata', async () => {
    const customTheme = {
      preset: 'starship-ops' as const,
      mode: 'light' as const,
      palette: 'starship-ops' as const,
      style: 'industrial' as const,
    };
    prisma.opsMemory.upsert.mockResolvedValueOnce({
      id: 'mem-3',
      updatedAt: new Date('2026-02-20T13:00:00.000Z'),
    });
    auditService.write.mockResolvedValueOnce({});

    const result = await service.updateTheme('user-1', customTheme);

    expect(prisma.opsMemory.upsert).toHaveBeenCalledWith({
      where: {
        userId_key: {
          userId: 'user-1',
          key: UI_THEME_MEMORY_KEY,
        },
      },
      update: {
        value: customTheme,
      },
      create: {
        userId: 'user-1',
        key: UI_THEME_MEMORY_KEY,
        value: customTheme,
      },
    });
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'ui.theme.update',
        success: true,
        paramsJson: expect.objectContaining({ preset: 'starship-ops', custom: true }),
      }),
    );
    expect(result).toEqual({
      theme: customTheme,
      isCustom: true,
      updatedAt: '2026-02-20T13:00:00.000Z',
    });
  });

  it('returns default hidden host preferences when unset', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce(null);

    const result = await service.getPreferences('user-1');

    expect(result).toEqual({
      preferences: {
        hiddenHostIds: [],
        discoverySubnets: defaultDiscoverySubnets,
        hostListColumns: defaultHostListColumns,
        dashboardSuggestionsNotice: defaultDashboardSuggestionsNotice,
        dashboardOrphanRecoveryNotice: defaultDashboardOrphanRecoveryNotice,
        sidebarNavigation: defaultSidebarNavigation,
      },
      updatedAt: null,
    });
  });

  it('treats legacy stored default themes as non-custom', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce({
      id: 'mem-legacy-default',
      value: {
        mode: 'dark',
        palette: 'ocean',
        style: 'soft',
      },
      updatedAt: new Date('2026-02-20T14:00:00.000Z'),
    });

    const result = await service.getTheme('user-1');

    expect(result).toEqual({
      theme: DEFAULT_UI_THEME,
      isCustom: false,
      updatedAt: '2026-02-20T14:00:00.000Z',
    });
  });

  it('persists hidden host preferences and writes audit metadata', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce(null);
    prisma.opsMemory.upsert.mockResolvedValueOnce({
      id: 'mem-hidden-1',
      updatedAt: new Date('2026-02-21T13:00:00.000Z'),
    });
    auditService.write.mockResolvedValueOnce({});

    const result = await service.updateHiddenHosts('user-1', [
      'd8ef4d73-c886-43cb-a6af-3eeb587f66af',
      'd8ef4d73-c886-43cb-a6af-3eeb587f66af',
    ]);

    expect(prisma.opsMemory.upsert).toHaveBeenCalledWith({
      where: {
        userId_key: {
          userId: 'user-1',
          key: 'ui_preferences_v1',
        },
      },
      update: {
        value: {
          hiddenHostIds: ['d8ef4d73-c886-43cb-a6af-3eeb587f66af'],
          discoverySubnets: defaultDiscoverySubnets,
          hostListColumns: defaultHostListColumns,
          dashboardSuggestionsNotice: defaultDashboardSuggestionsNotice,
          dashboardOrphanRecoveryNotice: defaultDashboardOrphanRecoveryNotice,
          sidebarNavigation: defaultSidebarNavigation,
        },
      },
      create: {
        userId: 'user-1',
        key: 'ui_preferences_v1',
        value: {
          hiddenHostIds: ['d8ef4d73-c886-43cb-a6af-3eeb587f66af'],
          discoverySubnets: defaultDiscoverySubnets,
          hostListColumns: defaultHostListColumns,
          dashboardSuggestionsNotice: defaultDashboardSuggestionsNotice,
          dashboardOrphanRecoveryNotice: defaultDashboardOrphanRecoveryNotice,
          sidebarNavigation: defaultSidebarNavigation,
        },
      },
    });
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'ui.preferences.hidden_hosts.update',
        success: true,
      }),
    );
    expect(result).toEqual({
      preferences: {
        hiddenHostIds: ['d8ef4d73-c886-43cb-a6af-3eeb587f66af'],
        discoverySubnets: defaultDiscoverySubnets,
        hostListColumns: defaultHostListColumns,
        dashboardSuggestionsNotice: defaultDashboardSuggestionsNotice,
        dashboardOrphanRecoveryNotice: defaultDashboardOrphanRecoveryNotice,
        sidebarNavigation: defaultSidebarNavigation,
      },
      updatedAt: '2026-02-21T13:00:00.000Z',
    });
  });

  it('persists empty hidden host preferences when set to empty', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce({
      id: 'mem-hidden-2',
      value: {
        hiddenHostIds: ['d8ef4d73-c886-43cb-a6af-3eeb587f66af'],
        discoverySubnets: ['192.168.50.0/24'],
        hostListColumns: {
          hiddenColumnIds: ['cpu'],
          widths: [{ id: 'hostname', widthPx: 280 }],
        },
        dashboardSuggestionsNotice: {
          dismissedFingerprint: 'fingerprint-1',
        },
        dashboardOrphanRecoveryNotice: {
          dismissedFingerprint: null,
        },
        sidebarNavigation: {
          orderedItemIds: ['alerts', 'dashboard'],
        },
      },
    });
    prisma.opsMemory.upsert.mockResolvedValueOnce({
      id: 'mem-hidden-2',
      updatedAt: new Date('2026-02-22T13:00:00.000Z'),
    });
    auditService.write.mockResolvedValueOnce({});

    const result = await service.updateHiddenHosts('user-1', []);

    expect(prisma.opsMemory.upsert).toHaveBeenCalledWith({
      where: {
        userId_key: {
          userId: 'user-1',
          key: 'ui_preferences_v1',
        },
      },
      update: {
        value: {
          hiddenHostIds: [],
          discoverySubnets: ['192.168.50.0/24'],
          hostListColumns: {
            hiddenColumnIds: ['cpu'],
            widths: [{ id: 'hostname', widthPx: 280 }],
          },
          dashboardSuggestionsNotice: {
            dismissedFingerprint: 'fingerprint-1',
          },
          dashboardOrphanRecoveryNotice: {
            dismissedFingerprint: null,
          },
          sidebarNavigation: normalizedSidebarNavigation('alerts', 'dashboard'),
        },
      },
      create: {
        userId: 'user-1',
        key: 'ui_preferences_v1',
        value: {
          hiddenHostIds: [],
          discoverySubnets: ['192.168.50.0/24'],
          hostListColumns: {
            hiddenColumnIds: ['cpu'],
            widths: [{ id: 'hostname', widthPx: 280 }],
          },
          dashboardSuggestionsNotice: {
            dismissedFingerprint: 'fingerprint-1',
          },
          dashboardOrphanRecoveryNotice: {
            dismissedFingerprint: null,
          },
          sidebarNavigation: normalizedSidebarNavigation('alerts', 'dashboard'),
        },
      },
    });
    expect(prisma.opsMemory.delete).not.toHaveBeenCalled();
    expect(result).toEqual({
      preferences: {
        hiddenHostIds: [],
        discoverySubnets: ['192.168.50.0/24'],
        hostListColumns: {
          hiddenColumnIds: ['cpu'],
          widths: [{ id: 'hostname', widthPx: 280 }],
        },
        dashboardSuggestionsNotice: {
          dismissedFingerprint: 'fingerprint-1',
        },
        dashboardOrphanRecoveryNotice: {
          dismissedFingerprint: null,
        },
        sidebarNavigation: normalizedSidebarNavigation('alerts', 'dashboard'),
      },
      updatedAt: '2026-02-22T13:00:00.000Z',
    });
  });

  it('persists host-list columns and preserves other preferences', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce({
      id: 'mem-cols-1',
      value: {
        hiddenHostIds: ['d8ef4d73-c886-43cb-a6af-3eeb587f66af'],
        discoverySubnets: ['192.168.60.0/24'],
        dashboardSuggestionsNotice: {
          dismissedFingerprint: 'fingerprint-2',
        },
      },
    });
    prisma.opsMemory.upsert.mockResolvedValueOnce({
      id: 'mem-cols-1',
      updatedAt: new Date('2026-02-22T14:00:00.000Z'),
    });
    auditService.write.mockResolvedValueOnce({});

    const result = await service.updateHostListColumns('user-1', {
      hiddenColumnIds: ['cpu', 'cpu'],
      widths: [
        { id: 'hostname', widthPx: 280 },
        { id: 'hostname', widthPx: 300 },
        { id: 'cpu', widthPx: 24 },
      ],
    });

    expect(prisma.opsMemory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          value: {
            hiddenHostIds: ['d8ef4d73-c886-43cb-a6af-3eeb587f66af'],
            discoverySubnets: ['192.168.60.0/24'],
            hostListColumns: {
              hiddenColumnIds: ['cpu'],
              widths: [
                { id: 'hostname', widthPx: 280 },
                { id: 'cpu', widthPx: 80 },
              ],
            },
            dashboardSuggestionsNotice: {
              dismissedFingerprint: 'fingerprint-2',
            },
            dashboardOrphanRecoveryNotice: {
              dismissedFingerprint: null,
            },
            sidebarNavigation: defaultSidebarNavigation,
          },
        },
      }),
    );
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'ui.preferences.host_list_columns.update',
        success: true,
      }),
    );
    expect(result).toEqual({
      preferences: {
        hiddenHostIds: ['d8ef4d73-c886-43cb-a6af-3eeb587f66af'],
        discoverySubnets: ['192.168.60.0/24'],
        hostListColumns: {
          hiddenColumnIds: ['cpu'],
          widths: [
            { id: 'hostname', widthPx: 280 },
            { id: 'cpu', widthPx: 80 },
          ],
        },
        dashboardSuggestionsNotice: {
          dismissedFingerprint: 'fingerprint-2',
        },
        dashboardOrphanRecoveryNotice: {
          dismissedFingerprint: null,
        },
        sidebarNavigation: defaultSidebarNavigation,
      },
      updatedAt: '2026-02-22T14:00:00.000Z',
    });
  });

  it('persists suggestion notice dismissal and preserves other preferences', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce({
      id: 'mem-notice-1',
      value: {
        hiddenHostIds: [],
        discoverySubnets: ['192.168.60.0/24'],
        hostListColumns: {
          hiddenColumnIds: ['cpu'],
          widths: [{ id: 'hostname', widthPx: 280 }],
        },
      },
    });
    prisma.opsMemory.upsert.mockResolvedValueOnce({
      id: 'mem-notice-1',
      updatedAt: new Date('2026-02-22T15:00:00.000Z'),
    });
    auditService.write.mockResolvedValueOnce({});

    const result = await service.updateDashboardSuggestionsNotice(
      'user-1',
      '  batch-fingerprint-2026  ',
    );

    expect(prisma.opsMemory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          value: {
            hiddenHostIds: [],
            discoverySubnets: ['192.168.60.0/24'],
            hostListColumns: {
              hiddenColumnIds: ['cpu'],
              widths: [{ id: 'hostname', widthPx: 280 }],
            },
            dashboardSuggestionsNotice: {
              dismissedFingerprint: 'batch-fingerprint-2026',
            },
            dashboardOrphanRecoveryNotice: {
              dismissedFingerprint: null,
            },
            sidebarNavigation: defaultSidebarNavigation,
          },
        },
      }),
    );
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'ui.preferences.dashboard_suggestions_notice.update',
        success: true,
      }),
    );
    expect(result).toEqual({
      preferences: {
        hiddenHostIds: [],
        discoverySubnets: ['192.168.60.0/24'],
        hostListColumns: {
          hiddenColumnIds: ['cpu'],
          widths: [{ id: 'hostname', widthPx: 280 }],
        },
        dashboardSuggestionsNotice: {
          dismissedFingerprint: 'batch-fingerprint-2026',
        },
        dashboardOrphanRecoveryNotice: {
          dismissedFingerprint: null,
        },
        sidebarNavigation: defaultSidebarNavigation,
      },
      updatedAt: '2026-02-22T15:00:00.000Z',
    });
  });

  it('persists orphan-recovery notice dismissal and preserves other preferences', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce({
      id: 'mem-orphan-notice-1',
      value: {
        hiddenHostIds: [],
        discoverySubnets: ['192.168.60.0/24'],
        hostListColumns: {
          hiddenColumnIds: ['cpu'],
          widths: [{ id: 'hostname', widthPx: 280 }],
        },
        dashboardSuggestionsNotice: {
          dismissedFingerprint: 'batch-fingerprint-2026',
        },
      },
    });
    prisma.opsMemory.upsert.mockResolvedValueOnce({
      id: 'mem-orphan-notice-1',
      updatedAt: new Date('2026-02-22T15:05:00.000Z'),
    });
    auditService.write.mockResolvedValueOnce({});

    const result = await service.updateDashboardOrphanRecoveryNotice(
      'user-1',
      '  fnv1a-orphan-a  ',
    );

    expect(prisma.opsMemory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          value: {
            hiddenHostIds: [],
            discoverySubnets: ['192.168.60.0/24'],
            hostListColumns: {
              hiddenColumnIds: ['cpu'],
              widths: [{ id: 'hostname', widthPx: 280 }],
            },
            dashboardSuggestionsNotice: {
              dismissedFingerprint: 'batch-fingerprint-2026',
            },
            dashboardOrphanRecoveryNotice: {
              dismissedFingerprint: 'fnv1a-orphan-a',
            },
            sidebarNavigation: defaultSidebarNavigation,
          },
        },
      }),
    );
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'ui.preferences.dashboard_orphan_recovery_notice.update',
        success: true,
      }),
    );
    expect(result).toEqual({
      preferences: {
        hiddenHostIds: [],
        discoverySubnets: ['192.168.60.0/24'],
        hostListColumns: {
          hiddenColumnIds: ['cpu'],
          widths: [{ id: 'hostname', widthPx: 280 }],
        },
        dashboardSuggestionsNotice: {
          dismissedFingerprint: 'batch-fingerprint-2026',
        },
        dashboardOrphanRecoveryNotice: {
          dismissedFingerprint: 'fnv1a-orphan-a',
        },
        sidebarNavigation: defaultSidebarNavigation,
      },
      updatedAt: '2026-02-22T15:05:00.000Z',
    });
  });

  it('normalizes stored sidebar navigation order when reading preferences', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce({
      id: 'mem-sidebar-1',
      value: {
        hiddenHostIds: [],
        discoverySubnets: defaultDiscoverySubnets,
        hostListColumns: defaultHostListColumns,
        dashboardSuggestionsNotice: defaultDashboardSuggestionsNotice,
        dashboardOrphanRecoveryNotice: defaultDashboardOrphanRecoveryNotice,
        sidebarNavigation: {
          orderedItemIds: ['hosts', 'dashboard-agent', 'hosts', 'dashboard'],
        },
      },
      updatedAt: new Date('2026-03-08T10:00:00.000Z'),
    });

    const result = await service.getPreferences('user-1');

    expect(result).toEqual({
      preferences: {
        hiddenHostIds: [],
        discoverySubnets: defaultDiscoverySubnets,
        hostListColumns: defaultHostListColumns,
        dashboardSuggestionsNotice: defaultDashboardSuggestionsNotice,
        dashboardOrphanRecoveryNotice: defaultDashboardOrphanRecoveryNotice,
        sidebarNavigation: normalizedSidebarNavigation('hosts', 'dashboard-agent', 'dashboard'),
      },
      updatedAt: '2026-03-08T10:00:00.000Z',
    });
  });

  it('persists normalized sidebar navigation and preserves other preferences', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce({
      id: 'mem-sidebar-2',
      value: {
        hiddenHostIds: ['d8ef4d73-c886-43cb-a6af-3eeb587f66af'],
        discoverySubnets: ['192.168.60.0/24'],
        hostListColumns: {
          hiddenColumnIds: ['cpu'],
          widths: [{ id: 'hostname', widthPx: 280 }],
        },
        dashboardSuggestionsNotice: {
          dismissedFingerprint: 'fingerprint-2',
        },
        dashboardOrphanRecoveryNotice: {
          dismissedFingerprint: null,
        },
      },
    });
    prisma.opsMemory.upsert.mockResolvedValueOnce({
      id: 'mem-sidebar-2',
      updatedAt: new Date('2026-03-08T11:00:00.000Z'),
    });
    auditService.write.mockResolvedValueOnce({});

    const result = await service.updateSidebarNavigation('user-1', [
      'hosts',
      'dashboard',
      'hosts',
      'settings',
    ] as SidebarNavItemId[]);

    expect(prisma.opsMemory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          value: {
            hiddenHostIds: ['d8ef4d73-c886-43cb-a6af-3eeb587f66af'],
            discoverySubnets: ['192.168.60.0/24'],
            hostListColumns: {
              hiddenColumnIds: ['cpu'],
              widths: [{ id: 'hostname', widthPx: 280 }],
            },
            dashboardSuggestionsNotice: {
              dismissedFingerprint: 'fingerprint-2',
            },
            dashboardOrphanRecoveryNotice: {
              dismissedFingerprint: null,
            },
            sidebarNavigation: normalizedSidebarNavigation('hosts', 'dashboard', 'settings'),
          },
        },
      }),
    );
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'ui.preferences.sidebar_navigation.update',
        paramsJson: {
          orderedItemIds: normalizedSidebarNavigation('hosts', 'dashboard', 'settings')
            .orderedItemIds,
        },
        success: true,
      }),
    );
    expect(result).toEqual({
      preferences: {
        hiddenHostIds: ['d8ef4d73-c886-43cb-a6af-3eeb587f66af'],
        discoverySubnets: ['192.168.60.0/24'],
        hostListColumns: {
          hiddenColumnIds: ['cpu'],
          widths: [{ id: 'hostname', widthPx: 280 }],
        },
        dashboardSuggestionsNotice: {
          dismissedFingerprint: 'fingerprint-2',
        },
        dashboardOrphanRecoveryNotice: {
          dismissedFingerprint: null,
        },
        sidebarNavigation: normalizedSidebarNavigation('hosts', 'dashboard', 'settings'),
      },
      updatedAt: '2026-03-08T11:00:00.000Z',
    });
  });
});
