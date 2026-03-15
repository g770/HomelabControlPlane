/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the ui theme test behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_THEME,
  isDefaultUiTheme,
  readUiThemeFromJson,
} from '../src/modules/users/ui-theme';

describe('ui theme helpers', () => {
  it('parses direct theme records', () => {
    const parsed = readUiThemeFromJson({
      preset: 'neon-grid',
      mode: 'light',
      palette: 'neon-grid',
      style: 'grid',
    });

    expect(parsed).toEqual({
      preset: 'neon-grid',
      mode: 'light',
      palette: 'neon-grid',
      style: 'grid',
    });
  });

  it('parses nested legacy theme records and marks them custom', () => {
    const parsed = readUiThemeFromJson({
      theme: {
        mode: 'dark',
        palette: 'forest',
        style: 'glass',
      },
    });

    expect(parsed).toEqual({
      preset: 'custom',
      mode: 'dark',
      palette: 'forest',
      style: 'glass',
    });
  });

  it('parses serialized theme JSON strings', () => {
    const parsed = readUiThemeFromJson(
      JSON.stringify({
        preset: 'starship-ops',
        mode: 'dark',
        palette: 'starship-ops',
        style: 'industrial',
      }),
    );

    expect(parsed).toEqual({
      preset: 'starship-ops',
      mode: 'dark',
      palette: 'starship-ops',
      style: 'industrial',
    });
  });

  it('normalizes legacy default theme records to the default preset', () => {
    const parsed = readUiThemeFromJson({
      mode: 'dark',
      palette: 'ocean',
      style: 'soft',
    });

    expect(parsed).toEqual(DEFAULT_UI_THEME);
  });

  it('returns null for invalid values', () => {
    expect(readUiThemeFromJson({})).toBeNull();
    expect(readUiThemeFromJson('not-json')).toBeNull();
    expect(readUiThemeFromJson(null)).toBeNull();
  });

  it('detects default theme accurately', () => {
    expect(isDefaultUiTheme(DEFAULT_UI_THEME)).toBe(true);
    expect(
      isDefaultUiTheme({
        ...DEFAULT_UI_THEME,
        preset: 'custom',
      }),
    ).toBe(false);
    expect(
      isDefaultUiTheme({
        ...DEFAULT_UI_THEME,
        palette: 'forest',
      }),
    ).toBe(false);
  });
});
