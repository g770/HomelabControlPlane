/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module provides the proxmox integration integration helpers for the surrounding feature.
 */
import {
  normalizeBaseUrl,
  readBoolean,
  readString,
  type ProxmoxCredentials,
} from './proxmox.client';

/**
 * Describes the proxmox integration fields shape.
 */
export type ProxmoxIntegrationFields = {
  baseUrl: string;
  allowInsecureTls: boolean;
  apiTokenId: string | null;
  hasApiTokenSecret: boolean;
};

/**
 * Implements read proxmox integration fields.
 */
export function readProxmoxIntegrationFields(
  config: Record<string, unknown>,
  credentials?: Record<string, unknown> | null,
): ProxmoxIntegrationFields {
  return {
    baseUrl: normalizeBaseUrl(readString(config.baseUrl) ?? ''),
    allowInsecureTls: readBoolean(config.allowInsecureTls),
    apiTokenId: readProxmoxTokenId(credentials ?? undefined),
    hasApiTokenSecret: hasProxmoxTokenSecret(credentials ?? undefined),
  };
}

/**
 * Builds stored proxmox config.
 */
export function buildStoredProxmoxConfig(input: { baseUrl: string; allowInsecureTls: boolean }) {
  return {
    baseUrl: normalizeBaseUrl(input.baseUrl),
    allowInsecureTls: Boolean(input.allowInsecureTls),
  };
}

/**
 * Builds stored proxmox credentials.
 */
export function buildStoredProxmoxCredentials(input: {
  apiTokenId: string;
  apiTokenSecret: string;
}): ProxmoxCredentials {
  return {
    apiTokenId: input.apiTokenId.trim(),
    apiTokenSecret: input.apiTokenSecret.trim(),
  };
}

/**
 * Implements read proxmox token id.
 */
export function readProxmoxTokenId(credentials?: Record<string, unknown> | null) {
  if (!credentials) {
    return null;
  }

  const explicitTokenId = readString(credentials.apiTokenId);
  if (explicitTokenId) {
    return explicitTokenId;
  }

  const legacyToken = readString(credentials.apiToken);
  if (!legacyToken) {
    return null;
  }

  const separatorIndex = legacyToken.indexOf('=');
  if (separatorIndex <= 0) {
    return null;
  }

  return legacyToken.slice(0, separatorIndex);
}

/**
 * Checks whether proxmox token secret.
 */
export function hasProxmoxTokenSecret(credentials?: Record<string, unknown> | null) {
  if (!credentials) {
    return false;
  }

  if (readString(credentials.apiTokenSecret)) {
    return true;
  }

  return Boolean(readString(credentials.apiToken));
}
