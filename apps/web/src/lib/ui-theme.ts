/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This utility module provides ui theme helpers for the application.
 */
import type {
  UiThemeMode,
  UiThemePalette,
  UiThemePreset,
  UiThemeSettings,
  UiThemeStyle,
} from '@homelab/shared';

// Browser-side theme utilities. This module is the single source of truth for
// local storage keys, fallback values, preset defaults, and DOM application behavior.
const UI_THEME_STORAGE_KEY = 'homelab-ui-theme-v1';
const LEGACY_THEME_STORAGE_KEY = 'homelab-theme';

const presetValues: UiThemePreset[] = [
  'default',
  'starship-ops',
  'luxury-ai',
  'neon-grid',
  'holographic-desk',
  'imperial-tactical',
  'matrix-lattice',
  'custom',
];
const modeValues: UiThemeMode[] = ['light', 'dark'];
const paletteValues: UiThemePalette[] = [
  'ocean',
  'forest',
  'sunset',
  'graphite',
  'aurora',
  'ember',
  'arctic',
  'starship-ops',
  'luxury-ai',
  'neon-grid',
  'holographic-desk',
  'imperial-tactical',
  'matrix-lattice',
];
const styleValues: UiThemeStyle[] = [
  'soft',
  'glass',
  'contrast',
  'industrial',
  'luxe',
  'grid',
  'holographic',
  'tactical',
  'lattice',
];

const uiThemePresetDefaults: Record<Exclude<UiThemePreset, 'custom'>, UiThemeSettings> = {
  default: {
    preset: 'default',
    mode: 'dark',
    palette: 'ocean',
    style: 'soft',
  },
  'starship-ops': {
    preset: 'starship-ops',
    mode: 'dark',
    palette: 'starship-ops',
    style: 'industrial',
  },
  'luxury-ai': {
    preset: 'luxury-ai',
    mode: 'dark',
    palette: 'luxury-ai',
    style: 'luxe',
  },
  'neon-grid': {
    preset: 'neon-grid',
    mode: 'dark',
    palette: 'neon-grid',
    style: 'grid',
  },
  'holographic-desk': {
    preset: 'holographic-desk',
    mode: 'dark',
    palette: 'holographic-desk',
    style: 'holographic',
  },
  'imperial-tactical': {
    preset: 'imperial-tactical',
    mode: 'dark',
    palette: 'imperial-tactical',
    style: 'tactical',
  },
  'matrix-lattice': {
    preset: 'matrix-lattice',
    mode: 'dark',
    palette: 'matrix-lattice',
    style: 'lattice',
  },
};

/**
 * Implements ui theme mode options.
 */
export const uiThemeModeOptions: Array<{ id: UiThemeMode; label: string; description: string }> = [
  { id: 'dark', label: 'Dark', description: 'Low-light friendly interface.' },
  { id: 'light', label: 'Light', description: 'Bright neutral interface.' },
];

/**
 * Implements ui theme preset options.
 */
export const uiThemePresetOptions: Array<{
  id: Exclude<UiThemePreset, 'custom'>;
  label: string;
  description: string;
  fontLabel: string;
  motifLabel: string;
  swatches: [string, string, string];
}> = [
  {
    id: 'default',
    label: 'Default Control Plane',
    description: 'Balanced glassy dark mode with ocean-blue accents.',
    fontLabel: 'Space Grotesk + IBM Plex Mono',
    motifLabel: 'Soft glow / rounded surfaces',
    swatches: ['#101924', '#0FB2DB', '#D6ECFF'],
  },
  {
    id: 'starship-ops',
    label: 'Starship Operations Console',
    description: 'Industrial CIC surfaces with tactical amber and sensor cyan.',
    fontLabel: 'Space Grotesk / Oxanium / IBM Plex Mono',
    motifLabel: 'Matte panels / compact density',
    swatches: ['#0B1116', '#E4A13A', '#62C6CF'],
  },
  {
    id: 'luxury-ai',
    label: 'Luxury AI Command Surface',
    description: 'Obsidian lacquer, ivory control room neutrals, and gilded accents.',
    fontLabel: 'Instrument Sans / Instrument Serif / IBM Plex Mono',
    motifLabel: 'Satin enamel / orbital linework',
    swatches: ['#0E0C0B', '#D5B06B', '#F5EEE3'],
  },
  {
    id: 'neon-grid',
    label: 'Neon Grid Interface',
    description: 'Laser-cyan modules with restrained magenta on midnight panels.',
    fontLabel: 'Space Grotesk / Rajdhani / IBM Plex Mono',
    motifLabel: 'Luminous rails / grid overlay',
    swatches: ['#070B14', '#2DE2E6', '#FF4FD8'],
  },
  {
    id: 'holographic-desk',
    label: 'Holographic Intelligence Desk',
    description: 'Smoked glass telemetry with cyan intelligence cues and amber highlights.',
    fontLabel: 'Space Grotesk / Chakra Petch / IBM Plex Mono',
    motifLabel: 'Layered glass / orbital dividers',
    swatches: ['#08131D', '#6BE7FF', '#FF9650'],
  },
  {
    id: 'imperial-tactical',
    label: 'Imperial Tactical Terminal',
    description: 'Gunmetal command hardware with disciplined amber and cold telemetry blue.',
    fontLabel: 'IBM Plex Sans Condensed / Oxanium / IBM Plex Mono',
    motifLabel: 'Clipped geometry / matte rails',
    swatches: ['#0E1113', '#D8A74A', '#79B9C8'],
  },
  {
    id: 'matrix-lattice',
    label: 'Matrix Diagnostic Lattice',
    description: 'Restrained phosphor greens on disciplined blackened monitoring panels.',
    fontLabel: 'IBM Plex Sans / IBM Plex Mono',
    motifLabel: 'Rectilinear lattice / phosphor restraint',
    swatches: ['#08110C', '#2E6A4C', '#7BE38F'],
  },
];

/**
 * Implements ui theme palette options.
 */
export const uiThemePaletteOptions: Array<{
  id: UiThemePalette;
  label: string;
  description: string;
}> = [
  { id: 'ocean', label: 'Ocean', description: 'Cool blue and cyan accents.' },
  { id: 'forest', label: 'Forest', description: 'Green and teal accents.' },
  { id: 'sunset', label: 'Sunset', description: 'Amber and red accents.' },
  { id: 'graphite', label: 'Graphite', description: 'Neutral grayscale accents.' },
  { id: 'aurora', label: 'Aurora', description: 'Electric cyan accents on deep neutrals.' },
  { id: 'ember', label: 'Ember', description: 'Hot amber and red accents.' },
  { id: 'arctic', label: 'Arctic', description: 'Icy blues with crisp contrast.' },
  { id: 'starship-ops', label: 'Starship Ops', description: 'Industrial amber and sensor cyan.' },
  { id: 'luxury-ai', label: 'Luxury AI', description: 'Obsidian, ivory, and gilded accents.' },
  { id: 'neon-grid', label: 'Neon Grid', description: 'Laser cyan with restrained magenta.' },
  {
    id: 'holographic-desk',
    label: 'Holographic Desk',
    description: 'Smoked blue glass with holo cyan.',
  },
  {
    id: 'imperial-tactical',
    label: 'Imperial Tactical',
    description: 'Gunmetal, amber, and telemetry blue.',
  },
  {
    id: 'matrix-lattice',
    label: 'Matrix Lattice',
    description: 'Phosphor greens on disciplined dark panels.',
  },
];

/**
 * Implements ui theme style options.
 */
export const uiThemeStyleOptions: Array<{ id: UiThemeStyle; label: string; description: string }> =
  [
    { id: 'soft', label: 'Soft', description: 'Rounded surfaces with subtle glow.' },
    { id: 'glass', label: 'Glass', description: 'Translucent cards with blur effects.' },
    { id: 'contrast', label: 'Contrast', description: 'Sharper surfaces and stronger borders.' },
    {
      id: 'industrial',
      label: 'Industrial',
      description: 'Matte control hardware with compact edges.',
    },
    {
      id: 'luxe',
      label: 'Luxe',
      description: 'Satin panels with restrained ceremonial highlights.',
    },
    {
      id: 'grid',
      label: 'Grid',
      description: 'Sharp frames with luminous rails and measured haze.',
    },
    {
      id: 'holographic',
      label: 'Holographic',
      description: 'Layered glass, inner glow, and floating telemetry.',
    },
    {
      id: 'tactical',
      label: 'Tactical',
      description: 'Clipped geometry, dense spacing, and strict borders.',
    },
    {
      id: 'lattice',
      label: 'Lattice',
      description: 'Rectilinear monitor panels with phosphor restraint.',
    },
  ];

/**
 * Implements default ui theme settings.
 */
export const defaultUiThemeSettings: UiThemeSettings = uiThemePresetDefaults.default;

/**
 * Builds ui theme preset settings.
 */
export function buildUiThemePresetSettings(
  preset: Exclude<UiThemePreset, 'custom'>,
  mode?: UiThemeMode,
): UiThemeSettings {
  const defaults = uiThemePresetDefaults[preset];
  return {
    ...defaults,
    mode: isThemeMode(mode) ? mode : defaults.mode,
  };
}

// Guards against partial or stale payloads before applying settings.
export function normalizeUiThemeSettings(
  input: Partial<UiThemeSettings> | null | undefined,
): UiThemeSettings {
  if (!input) {
    return defaultUiThemeSettings;
  }

  const preset = isThemePreset(input.preset) ? input.preset : inferLegacyPreset(input);
  const presetDefaults =
    preset === 'custom' ? defaultUiThemeSettings : uiThemePresetDefaults[preset];
  const mode = isThemeMode(input.mode) ? input.mode : presetDefaults.mode;
  const palette =
    preset === 'custom' && isThemePalette(input.palette) ? input.palette : presetDefaults.palette;
  const style =
    preset === 'custom' && isThemeStyle(input.style) ? input.style : presetDefaults.style;

  return { preset, mode, palette, style };
}

// Reads current format first, then gracefully migrates the legacy mode key.
export function readStoredUiThemeSettings() {
  if (typeof window === 'undefined') {
    return defaultUiThemeSettings;
  }

  const raw = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parseUiTheme(parsed) ?? defaultUiThemeSettings;
    } catch {
      return defaultUiThemeSettings;
    }
  }

  const legacyMode = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
  if (legacyMode === 'dark' || legacyMode === 'light') {
    return {
      ...defaultUiThemeSettings,
      mode: legacyMode as UiThemeMode,
    };
  }

  return defaultUiThemeSettings;
}

/**
 * Implements persist ui theme settings.
 */
export function persistUiThemeSettings(theme: UiThemeSettings) {
  if (typeof window === 'undefined') {
    return;
  }

  const normalized = normalizeUiThemeSettings(theme);
  window.localStorage.setItem(UI_THEME_STORAGE_KEY, JSON.stringify(normalized));
  window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, normalized.mode);
}

// Applies theme settings by updating root class/data attributes used by CSS.
export function applyUiThemeSettings(theme: UiThemeSettings) {
  if (typeof document === 'undefined') {
    return;
  }

  const normalized = normalizeUiThemeSettings(theme);
  const root = document.documentElement;
  root.classList.toggle('dark', normalized.mode === 'dark');
  root.dataset.themePreset = normalized.preset;
  root.dataset.themePalette = normalized.palette;
  root.dataset.themeStyle = normalized.style;
}

/**
 * Parses ui theme.
 */
function parseUiTheme(input: unknown): UiThemeSettings | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  return normalizeUiThemeSettings({
    preset: isThemePreset(record.preset) ? record.preset : undefined,
    mode: isThemeMode(record.mode) ? record.mode : undefined,
    palette: isThemePalette(record.palette) ? record.palette : undefined,
    style: isThemeStyle(record.style) ? record.style : undefined,
  });
}

/**
 * Implements infer legacy preset.
 */
function inferLegacyPreset(input: Partial<UiThemeSettings>): UiThemePreset {
  if (!isThemeMode(input.mode) || !isThemePalette(input.palette) || !isThemeStyle(input.style)) {
    return 'default';
  }

  return input.mode === defaultUiThemeSettings.mode &&
    input.palette === defaultUiThemeSettings.palette &&
    input.style === defaultUiThemeSettings.style
    ? 'default'
    : 'custom';
}

/**
 * Checks whether theme preset.
 */
function isThemePreset(value: unknown): value is UiThemePreset {
  return typeof value === 'string' && presetValues.includes(value as UiThemePreset);
}

/**
 * Checks whether theme mode.
 */
function isThemeMode(value: unknown): value is UiThemeMode {
  return typeof value === 'string' && modeValues.includes(value as UiThemeMode);
}

/**
 * Checks whether theme palette.
 */
function isThemePalette(value: unknown): value is UiThemePalette {
  return typeof value === 'string' && paletteValues.includes(value as UiThemePalette);
}

/**
 * Checks whether theme style.
 */
function isThemeStyle(value: unknown): value is UiThemeStyle {
  return typeof value === 'string' && styleValues.includes(value as UiThemeStyle);
}
