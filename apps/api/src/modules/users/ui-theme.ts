/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the ui theme logic for the repository.
 */
import type { Prisma } from '@prisma/client';
import {
  uiThemeModeSchema,
  uiThemePaletteSchema,
  uiThemeSettingsSchema,
  uiThemeStyleSchema,
  type UiThemeSettings,
} from '@homelab/shared';

// Persists per-user UI preferences that override default theme settings.
export const UI_THEME_MEMORY_KEY = 'ui_theme_v1';

/**
 * Defines the default_ui_theme constant.
 */
export const DEFAULT_UI_THEME: UiThemeSettings = {
  preset: 'default',
  mode: 'dark',
  palette: 'ocean',
  style: 'soft',
};

// Used to decide when we can remove stored overrides and fall back to defaults.
export function isDefaultUiTheme(theme: UiThemeSettings) {
  return (
    theme.preset === DEFAULT_UI_THEME.preset &&
    theme.mode === DEFAULT_UI_THEME.mode &&
    theme.palette === DEFAULT_UI_THEME.palette &&
    theme.style === DEFAULT_UI_THEME.style
  );
}

// Accepts both direct JSON objects and legacy string payloads from ops memory.
export function readUiThemeFromJson(
  value: Prisma.JsonValue | null | undefined,
): UiThemeSettings | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseUiThemeCandidate(parsed);
    } catch {
      return null;
    }
  }

  return parseUiThemeCandidate(value);
}

/**
 * Parses ui theme candidate.
 */
function parseUiThemeCandidate(candidate: unknown): UiThemeSettings | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }

  const direct = uiThemeSettingsSchema.safeParse(candidate);
  if (direct.success) {
    return direct.data;
  }

  const record = candidate as Record<string, unknown>;
  const nested = uiThemeSettingsSchema.safeParse(record.theme);
  if (nested.success) {
    return nested.data;
  }

  const legacyTheme = parseLegacyUiThemeRecord(record);
  if (legacyTheme) {
    return legacyTheme;
  }

  if (record.theme && typeof record.theme === 'object' && !Array.isArray(record.theme)) {
    return parseLegacyUiThemeRecord(record.theme as Record<string, unknown>);
  }

  return null;
}

/**
 * Parses legacy ui theme record.
 */
function parseLegacyUiThemeRecord(record: Record<string, unknown>): UiThemeSettings | null {
  const mode = uiThemeModeSchema.safeParse(record.mode);
  const palette = uiThemePaletteSchema.safeParse(record.palette);
  const style = uiThemeStyleSchema.safeParse(record.style);
  if (!mode.success || !palette.success || !style.success) {
    return null;
  }

  const legacyTheme = {
    mode: mode.data,
    palette: palette.data,
    style: style.data,
  };

  return {
    preset: matchesDefaultUiThemeFields(legacyTheme) ? 'default' : 'custom',
    ...legacyTheme,
  };
}

/**
 * Implements matches default ui theme fields.
 */
function matchesDefaultUiThemeFields(theme: Pick<UiThemeSettings, 'mode' | 'palette' | 'style'>) {
  return (
    theme.mode === DEFAULT_UI_THEME.mode &&
    theme.palette === DEFAULT_UI_THEME.palette &&
    theme.style === DEFAULT_UI_THEME.style
  );
}
