/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements users service business logic for the service layer.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  defaultSidebarNavigationOrderedItemIds,
  type SidebarNavItemId,
  type UiThemeSettings,
  type UserPreferences,
} from '@homelab/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DEFAULT_UI_THEME,
  isDefaultUiTheme,
  readUiThemeFromJson,
  UI_THEME_MEMORY_KEY,
} from './ui-theme';

const USER_PREFERENCES_MEMORY_KEY = 'ui_preferences_v1';
const maxHiddenHosts = 5000;
const maxDiscoverySubnets = 128;
const defaultDiscoverySubnets = ['10.0.0.0/24', '172.16.0.0/24', '192.168.1.0/24'] as const;
const minHostListColumnWidth = 80;
const maxHostListColumnWidth = 640;
const hostListColumnIds = [
  'index',
  'hostname',
  'ip',
  'tags',
  'type',
  'status',
  'cpu',
  'mem',
  'disk',
  'lastSeen',
  'agentVersion',
  'visibility',
  'terminal',
] as const;
const hostListHideableColumnIds = [
  'ip',
  'tags',
  'type',
  'status',
  'cpu',
  'mem',
  'disk',
  'lastSeen',
  'agentVersion',
  'visibility',
] as const;
const maxHostListHiddenColumns = hostListHideableColumnIds.length;
const maxHostListColumnWidths = hostListColumnIds.length;
const maxSuggestionNoticeFingerprintLength = 256;
const defaultHostListColumns: UserPreferences['hostListColumns'] = {
  hiddenColumnIds: [],
  widths: [],
};
const defaultDashboardSuggestionsNotice: UserPreferences['dashboardSuggestionsNotice'] = {
  dismissedFingerprint: null,
};
const defaultDashboardOrphanRecoveryNotice: UserPreferences['dashboardOrphanRecoveryNotice'] = {
  dismissedFingerprint: null,
};
const defaultSidebarNavigation: UserPreferences['sidebarNavigation'] = {
  orderedItemIds: defaultSidebarNavigationOrderedItemIds.slice(),
};
const sidebarNavItemIdSet = new Set<SidebarNavItemId>(defaultSidebarNavigationOrderedItemIds);

// Handles per-user UI preference persistence for the built-in admin account.
@Injectable()
/**
 * Implements the users service class.
 */
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  // Reads theme override from ops memory and falls back to defaults.
  async getTheme(userId: string) {
    const existing = await this.prisma.opsMemory.findUnique({
      where: {
        userId_key: {
          userId,
          key: UI_THEME_MEMORY_KEY,
        },
      },
    });

    const stored = readUiThemeFromJson(existing?.value);
    return {
      theme: stored ?? DEFAULT_UI_THEME,
      isCustom: Boolean(stored && !isDefaultUiTheme(stored)),
      updatedAt: existing ? existing.updatedAt.toISOString() : null,
    };
  }

  // Stores non-default theme settings and deletes the row for default values.
  async updateTheme(userId: string, theme: UiThemeSettings) {
    if (isDefaultUiTheme(theme)) {
      const existing = await this.prisma.opsMemory.findUnique({
        where: {
          userId_key: {
            userId,
            key: UI_THEME_MEMORY_KEY,
          },
        },
      });

      if (existing) {
        await this.prisma.opsMemory.delete({
          where: {
            userId_key: {
              userId,
              key: UI_THEME_MEMORY_KEY,
            },
          },
        });
      }

      await this.auditService.write({
        actorUserId: userId,
        action: 'ui.theme.update',
        targetType: 'ops_memory',
        targetId: existing?.id,
        paramsJson: {
          preset: theme.preset,
          mode: theme.mode,
          palette: theme.palette,
          style: theme.style,
          custom: false,
        },
        success: true,
      });

      return this.getTheme(userId);
    }

    const saved = await this.prisma.opsMemory.upsert({
      where: {
        userId_key: {
          userId,
          key: UI_THEME_MEMORY_KEY,
        },
      },
      update: {
        value: theme as Prisma.InputJsonValue,
      },
      create: {
        userId,
        key: UI_THEME_MEMORY_KEY,
        value: theme as Prisma.InputJsonValue,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'ui.theme.update',
      targetType: 'ops_memory',
      targetId: saved.id,
      paramsJson: {
        preset: theme.preset,
        mode: theme.mode,
        palette: theme.palette,
        style: theme.style,
        custom: true,
      },
      success: true,
    });

    return {
      theme,
      isCustom: true,
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  // Reads user-scoped UI preferences persisted in ops memory.
  async getPreferences(userId: string) {
    const existing = await this.prisma.opsMemory.findUnique({
      where: {
        userId_key: {
          userId,
          key: USER_PREFERENCES_MEMORY_KEY,
        },
      },
    });

    return {
      preferences: readUserPreferencesFromJson(existing?.value),
      updatedAt: existing ? existing.updatedAt.toISOString() : null,
    };
  }

  // Persists hidden-host preferences for host list filtering per user.
  async updateHiddenHosts(userId: string, hiddenHostIds: string[]) {
    const { current } = await this.readCurrentUserPreferences(userId);
    const nextPreferences: UserPreferences = {
      hiddenHostIds: dedupeHiddenHostIds(hiddenHostIds),
      discoverySubnets: current.discoverySubnets,
      hostListColumns: current.hostListColumns,
      dashboardSuggestionsNotice: current.dashboardSuggestionsNotice,
      dashboardOrphanRecoveryNotice: current.dashboardOrphanRecoveryNotice,
      sidebarNavigation: current.sidebarNavigation,
    };
    const saved = await this.saveUserPreferences(userId, nextPreferences);

    await this.auditService.write({
      actorUserId: userId,
      action: 'ui.preferences.hidden_hosts.update',
      targetType: 'ops_memory',
      targetId: saved.id,
      paramsJson: {
        hiddenHostCount: nextPreferences.hiddenHostIds.length,
        subnetCount: nextPreferences.discoverySubnets.length,
      },
      success: true,
    });

    return {
      preferences: nextPreferences,
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  // Persists user-defined subnet defaults for manual discovery runs.
  async updateDiscoverySubnets(userId: string, discoverySubnets: string[]) {
    const { current } = await this.readCurrentUserPreferences(userId);
    const nextPreferences: UserPreferences = {
      hiddenHostIds: current.hiddenHostIds,
      discoverySubnets: dedupeDiscoverySubnets(discoverySubnets),
      hostListColumns: current.hostListColumns,
      dashboardSuggestionsNotice: current.dashboardSuggestionsNotice,
      dashboardOrphanRecoveryNotice: current.dashboardOrphanRecoveryNotice,
      sidebarNavigation: current.sidebarNavigation,
    };
    const saved = await this.saveUserPreferences(userId, nextPreferences);

    await this.auditService.write({
      actorUserId: userId,
      action: 'ui.preferences.discovery_subnets.update',
      targetType: 'ops_memory',
      targetId: saved.id,
      paramsJson: {
        hiddenHostCount: nextPreferences.hiddenHostIds.length,
        subnetCount: nextPreferences.discoverySubnets.length,
      },
      success: true,
    });

    return {
      preferences: nextPreferences,
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  // Persists host-list table column visibility/width preferences.
  async updateHostListColumns(userId: string, hostListColumns: UserPreferences['hostListColumns']) {
    const { current } = await this.readCurrentUserPreferences(userId);
    const normalizedColumns = normalizeHostListColumns(hostListColumns);
    const nextPreferences: UserPreferences = {
      hiddenHostIds: current.hiddenHostIds,
      discoverySubnets: current.discoverySubnets,
      hostListColumns: normalizedColumns,
      dashboardSuggestionsNotice: current.dashboardSuggestionsNotice,
      dashboardOrphanRecoveryNotice: current.dashboardOrphanRecoveryNotice,
      sidebarNavigation: current.sidebarNavigation,
    };
    const saved = await this.saveUserPreferences(userId, nextPreferences);

    await this.auditService.write({
      actorUserId: userId,
      action: 'ui.preferences.host_list_columns.update',
      targetType: 'ops_memory',
      targetId: saved.id,
      paramsJson: {
        hiddenHostCount: nextPreferences.hiddenHostIds.length,
        subnetCount: nextPreferences.discoverySubnets.length,
        hiddenColumnCount: normalizedColumns.hiddenColumnIds.length,
        customWidthCount: normalizedColumns.widths.length,
      },
      success: true,
    });

    return {
      preferences: nextPreferences,
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  // Persists the latest suggestion-batch fingerprint dismissed by the user.
  async updateDashboardSuggestionsNotice(userId: string, dismissedFingerprint: string | null) {
    const { current } = await this.readCurrentUserPreferences(userId);
    const normalizedNotice = normalizeDashboardNotice({
      dismissedFingerprint,
    });
    const nextPreferences: UserPreferences = {
      hiddenHostIds: current.hiddenHostIds,
      discoverySubnets: current.discoverySubnets,
      hostListColumns: current.hostListColumns,
      dashboardSuggestionsNotice: normalizedNotice,
      dashboardOrphanRecoveryNotice: current.dashboardOrphanRecoveryNotice,
      sidebarNavigation: current.sidebarNavigation,
    };
    const saved = await this.saveUserPreferences(userId, nextPreferences);

    await this.auditService.write({
      actorUserId: userId,
      action: 'ui.preferences.dashboard_suggestions_notice.update',
      targetType: 'ops_memory',
      targetId: saved.id,
      paramsJson: {
        hiddenHostCount: nextPreferences.hiddenHostIds.length,
        subnetCount: nextPreferences.discoverySubnets.length,
        dismissedFingerprintSet: Boolean(normalizedNotice.dismissedFingerprint),
      },
      success: true,
    });

    return {
      preferences: nextPreferences,
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  // Persists the latest orphan-recovery notice fingerprint dismissed by the user.
  async updateDashboardOrphanRecoveryNotice(userId: string, dismissedFingerprint: string | null) {
    const { current } = await this.readCurrentUserPreferences(userId);
    const normalizedNotice = normalizeDashboardNotice({
      dismissedFingerprint,
    });
    const nextPreferences: UserPreferences = {
      hiddenHostIds: current.hiddenHostIds,
      discoverySubnets: current.discoverySubnets,
      hostListColumns: current.hostListColumns,
      dashboardSuggestionsNotice: current.dashboardSuggestionsNotice,
      dashboardOrphanRecoveryNotice: normalizedNotice,
      sidebarNavigation: current.sidebarNavigation,
    };
    const saved = await this.saveUserPreferences(userId, nextPreferences);

    await this.auditService.write({
      actorUserId: userId,
      action: 'ui.preferences.dashboard_orphan_recovery_notice.update',
      targetType: 'ops_memory',
      targetId: saved.id,
      paramsJson: {
        hiddenHostCount: nextPreferences.hiddenHostIds.length,
        subnetCount: nextPreferences.discoverySubnets.length,
        dismissedFingerprintSet: Boolean(normalizedNotice.dismissedFingerprint),
      },
      success: true,
    });

    return {
      preferences: nextPreferences,
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  // Persists sidebar navigation order per user and normalizes stale or partial payloads.
  async updateSidebarNavigation(userId: string, orderedItemIds: SidebarNavItemId[]) {
    const { current } = await this.readCurrentUserPreferences(userId);
    const normalizedSidebarNavigation = normalizeSidebarNavigation({ orderedItemIds });
    const nextPreferences: UserPreferences = {
      hiddenHostIds: current.hiddenHostIds,
      discoverySubnets: current.discoverySubnets,
      hostListColumns: current.hostListColumns,
      dashboardSuggestionsNotice: current.dashboardSuggestionsNotice,
      dashboardOrphanRecoveryNotice: current.dashboardOrphanRecoveryNotice,
      sidebarNavigation: normalizedSidebarNavigation,
    };
    const saved = await this.saveUserPreferences(userId, nextPreferences);

    await this.auditService.write({
      actorUserId: userId,
      action: 'ui.preferences.sidebar_navigation.update',
      targetType: 'ops_memory',
      targetId: saved.id,
      paramsJson: {
        orderedItemIds: normalizedSidebarNavigation.orderedItemIds,
      },
      success: true,
    });

    return {
      preferences: nextPreferences,
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  /**
   * Handles read current user preferences.
   */
  private async readCurrentUserPreferences(userId: string) {
    const existing = await this.prisma.opsMemory.findUnique({
      where: {
        userId_key: {
          userId,
          key: USER_PREFERENCES_MEMORY_KEY,
        },
      },
    });

    return {
      existing,
      current: readUserPreferencesFromJson(existing?.value),
    };
  }

  /**
   * Handles save user preferences.
   */
  private async saveUserPreferences(userId: string, preferences: UserPreferences) {
    return this.prisma.opsMemory.upsert({
      where: {
        userId_key: {
          userId,
          key: USER_PREFERENCES_MEMORY_KEY,
        },
      },
      update: {
        value: preferences as Prisma.InputJsonValue,
      },
      create: {
        userId,
        key: USER_PREFERENCES_MEMORY_KEY,
        value: preferences as Prisma.InputJsonValue,
      },
    });
  }
}

/**
 * Implements read user preferences from json.
 */
function readUserPreferencesFromJson(value: unknown): UserPreferences {
  if (!value || typeof value !== 'object') {
    return {
      hiddenHostIds: [],
      discoverySubnets: defaultDiscoverySubnets.slice(),
      hostListColumns: {
        hiddenColumnIds: defaultHostListColumns.hiddenColumnIds.slice(),
        widths: defaultHostListColumns.widths.slice(),
      },
      dashboardSuggestionsNotice: {
        dismissedFingerprint: defaultDashboardSuggestionsNotice.dismissedFingerprint,
      },
      dashboardOrphanRecoveryNotice: {
        dismissedFingerprint: defaultDashboardOrphanRecoveryNotice.dismissedFingerprint,
      },
      sidebarNavigation: {
        orderedItemIds: defaultSidebarNavigation.orderedItemIds.slice(),
      },
    };
  }

  const record = value as Record<string, unknown>;
  const ids = Array.isArray(record.hiddenHostIds)
    ? record.hiddenHostIds
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];
  const subnets = Array.isArray(record.discoverySubnets)
    ? record.discoverySubnets
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : defaultDiscoverySubnets.slice();
  const hostListColumns = normalizeHostListColumns(record.hostListColumns);
  const dashboardSuggestionsNotice = normalizeDashboardNotice(record.dashboardSuggestionsNotice);
  const dashboardOrphanRecoveryNotice = normalizeDashboardNotice(
    record.dashboardOrphanRecoveryNotice,
  );
  const sidebarNavigation = normalizeSidebarNavigation(record.sidebarNavigation);

  return {
    hiddenHostIds: dedupeHiddenHostIds(ids),
    discoverySubnets: dedupeDiscoverySubnets(subnets),
    hostListColumns,
    dashboardSuggestionsNotice,
    dashboardOrphanRecoveryNotice,
    sidebarNavigation,
  };
}

/**
 * Implements dedupe hidden host ids.
 */
function dedupeHiddenHostIds(hiddenHostIds: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of hiddenHostIds) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    deduped.push(trimmed);
    if (deduped.length >= maxHiddenHosts) {
      break;
    }
  }
  return deduped;
}

/**
 * Implements dedupe discovery subnets.
 */
function dedupeDiscoverySubnets(discoverySubnets: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const subnet of discoverySubnets) {
    const trimmed = subnet.trim().toLowerCase();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    deduped.push(trimmed);
    if (deduped.length >= maxDiscoverySubnets) {
      break;
    }
  }
  return deduped;
}

/**
 * Implements normalize host list columns.
 */
function normalizeHostListColumns(value: unknown): UserPreferences['hostListColumns'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      hiddenColumnIds: defaultHostListColumns.hiddenColumnIds.slice(),
      widths: defaultHostListColumns.widths.slice(),
    };
  }

  const record = value as Record<string, unknown>;
  const hiddenIds = Array.isArray(record.hiddenColumnIds) ? record.hiddenColumnIds : [];
  const widths = Array.isArray(record.widths) ? record.widths : [];

  const hiddenSeen = new Set<string>();
  const normalizedHidden: UserPreferences['hostListColumns']['hiddenColumnIds'] = [];
  for (const candidate of hiddenIds) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (
      !trimmed ||
      hiddenSeen.has(trimmed) ||
      !hostListHideableColumnIds.includes(trimmed as (typeof hostListHideableColumnIds)[number])
    ) {
      continue;
    }
    hiddenSeen.add(trimmed);
    normalizedHidden.push(trimmed as UserPreferences['hostListColumns']['hiddenColumnIds'][number]);
    if (normalizedHidden.length >= maxHostListHiddenColumns) {
      break;
    }
  }

  const widthSeen = new Set<string>();
  const normalizedWidths: UserPreferences['hostListColumns']['widths'] = [];
  for (const candidate of widths) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }
    const entry = candidate as { id?: unknown; widthPx?: unknown };
    if (typeof entry.id !== 'string') {
      continue;
    }
    const id = entry.id.trim();
    if (
      !id ||
      widthSeen.has(id) ||
      !hostListColumnIds.includes(id as (typeof hostListColumnIds)[number])
    ) {
      continue;
    }
    const rawWidth = typeof entry.widthPx === 'number' ? entry.widthPx : Number(entry.widthPx);
    if (!Number.isFinite(rawWidth)) {
      continue;
    }
    const widthPx = Math.max(
      minHostListColumnWidth,
      Math.min(maxHostListColumnWidth, Math.round(rawWidth)),
    );
    widthSeen.add(id);
    normalizedWidths.push({
      id: id as UserPreferences['hostListColumns']['widths'][number]['id'],
      widthPx,
    });
    if (normalizedWidths.length >= maxHostListColumnWidths) {
      break;
    }
  }

  return {
    hiddenColumnIds: normalizedHidden,
    widths: normalizedWidths,
  };
}

/**
 * Implements normalize dashboard notice.
 */
function normalizeDashboardNotice(value: unknown): { dismissedFingerprint: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      dismissedFingerprint: null,
    };
  }
  const record = value as Record<string, unknown>;
  const raw = record.dismissedFingerprint;
  if (raw === null) {
    return {
      dismissedFingerprint: null,
    };
  }
  if (typeof raw !== 'string') {
    return {
      dismissedFingerprint: null,
    };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      dismissedFingerprint: null,
    };
  }
  return {
    dismissedFingerprint: trimmed.slice(0, maxSuggestionNoticeFingerprintLength),
  };
}

/**
 * Implements normalize sidebar navigation.
 */
function normalizeSidebarNavigation(value: unknown): UserPreferences['sidebarNavigation'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      orderedItemIds: defaultSidebarNavigation.orderedItemIds.slice(),
    };
  }

  const record = value as Record<string, unknown>;
  const rawOrderedItemIds = Array.isArray(record.orderedItemIds) ? record.orderedItemIds : [];
  const seen = new Set<SidebarNavItemId>();
  const orderedItemIds: SidebarNavItemId[] = [];

  for (const candidate of rawOrderedItemIds) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim() as SidebarNavItemId;
    if (!trimmed || seen.has(trimmed) || !sidebarNavItemIdSet.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    orderedItemIds.push(trimmed);
  }

  for (const sidebarNavItemId of defaultSidebarNavigationOrderedItemIds) {
    if (seen.has(sidebarNavItemId)) {
      continue;
    }
    orderedItemIds.push(sidebarNavItemId);
  }

  return { orderedItemIds };
}
