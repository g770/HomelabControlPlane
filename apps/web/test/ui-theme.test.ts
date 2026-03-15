/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the ui theme test behavior.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyUiThemeSettings,
  buildUiThemePresetSettings,
  defaultUiThemeSettings,
  normalizeUiThemeSettings,
  persistUiThemeSettings,
  readStoredUiThemeSettings,
} from '../src/lib/ui-theme';

type StorageMock = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ui theme utilities', () => {
  it('normalizes missing or invalid values to defaults', () => {
    expect(normalizeUiThemeSettings(null)).toEqual(defaultUiThemeSettings);
    expect(
      normalizeUiThemeSettings({
        preset: 'unknown' as any,
        mode: 'night' as any,
        palette: 'purple' as any,
        style: 'rounded' as any,
      }),
    ).toEqual(defaultUiThemeSettings);
  });

  it('normalizes legacy theme payloads to the custom preset unless they match default', () => {
    expect(
      normalizeUiThemeSettings({
        mode: 'light',
        palette: 'forest',
        style: 'glass',
      }),
    ).toEqual({
      preset: 'custom',
      mode: 'light',
      palette: 'forest',
      style: 'glass',
    });
    expect(
      normalizeUiThemeSettings({
        mode: 'dark',
        palette: 'ocean',
        style: 'soft',
      }),
    ).toEqual(defaultUiThemeSettings);
  });

  it('persists and reads modern theme storage format', () => {
    const storage = createStorageMock();
    vi.stubGlobal('window', {
      localStorage: storage,
    });

    persistUiThemeSettings({
      preset: 'starship-ops',
      mode: 'light',
      palette: 'starship-ops',
      style: 'industrial',
    });

    const restored = readStoredUiThemeSettings();
    expect(restored).toEqual({
      preset: 'starship-ops',
      mode: 'light',
      palette: 'starship-ops',
      style: 'industrial',
    });
    expect(storage.getItem('homelab-ui-theme-v1')).toContain('"preset":"starship-ops"');
    expect(storage.getItem('homelab-theme')).toBe('light');
  });

  it('falls back to legacy mode-only storage when needed', () => {
    const storage = createStorageMock({
      'homelab-theme': 'light',
    });
    vi.stubGlobal('window', {
      localStorage: storage,
    });

    const restored = readStoredUiThemeSettings();
    expect(restored).toEqual({
      preset: 'default',
      mode: 'light',
      palette: 'ocean',
      style: 'soft',
    });
  });

  it('builds curated preset defaults', () => {
    expect(buildUiThemePresetSettings('matrix-lattice')).toEqual({
      preset: 'matrix-lattice',
      mode: 'dark',
      palette: 'matrix-lattice',
      style: 'lattice',
    });
  });

  it('applies theme preset, mode, palette, and style to the document root', () => {
    const classState = new Set<string>();
    const root = {
      classList: {
        toggle: (name: string, enabled?: boolean) => {
          const nextEnabled = enabled ?? !classState.has(name);
          if (nextEnabled) {
            classState.add(name);
          } else {
            classState.delete(name);
          }
          return nextEnabled;
        },
      },
      dataset: {} as Record<string, string>,
    };
    vi.stubGlobal('document', {
      documentElement: root,
    });

    applyUiThemeSettings({
      preset: 'neon-grid',
      mode: 'dark',
      palette: 'neon-grid',
      style: 'grid',
    });

    expect(classState.has('dark')).toBe(true);
    expect(root.dataset.themePreset).toBe('neon-grid');
    expect(root.dataset.themePalette).toBe('neon-grid');
    expect(root.dataset.themeStyle).toBe('grid');

    applyUiThemeSettings({
      preset: 'custom',
      mode: 'light',
      palette: 'arctic',
      style: 'contrast',
    });

    expect(classState.has('dark')).toBe(false);
    expect(root.dataset.themePreset).toBe('custom');
    expect(root.dataset.themePalette).toBe('arctic');
    expect(root.dataset.themeStyle).toBe('contrast');
  });
});

/**
 * Creates storage mock.
 */
function createStorageMock(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));

  const storage: StorageMock = {
    /**
     * Gets item.
     */
    getItem(key: string) {
      return values.has(key) ? (values.get(key) ?? null) : null;
    },
    /**
     * Sets item.
     */
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    /**
     * Handles remove item.
     */
    removeItem(key: string) {
      values.delete(key);
    },
    /**
     * Handles clear.
     */
    clear() {
      values.clear();
    },
  };

  return storage;
}
