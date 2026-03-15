/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module provides the proxmox client integration helpers for the surrounding feature.
 */
import https from 'node:https';
import { URL } from 'node:url';

/**
 * Describes the proxmox config shape.
 */
export type ProxmoxConfig = {
  baseUrl: string;
  allowInsecureTls: boolean;
};

/**
 * Describes the proxmox credentials shape.
 */
export type ProxmoxCredentials = {
  apiToken?: string;
  apiTokenId?: string;
  apiTokenSecret?: string;
};

/**
 * Implements the proxmox client class.
 */
export class ProxmoxClient {
  private readonly baseUrl: string;

  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: ProxmoxConfig,
    private readonly credentials: ProxmoxCredentials,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = config.baseUrl;
    this.fetchImpl = fetchImpl;
  }

  static readConfig(config: Record<string, unknown>): ProxmoxConfig {
    const baseUrl = readString(config.baseUrl);
    if (!baseUrl) {
      throw new Error('Missing baseUrl');
    }

    return {
      baseUrl: normalizeBaseUrl(baseUrl),
      allowInsecureTls: readBoolean(config.allowInsecureTls),
    };
  }

  static readCredentials(credentials: Record<string, unknown>): ProxmoxCredentials {
    const legacyToken = readString(credentials.apiToken);
    if (legacyToken) {
      return { apiToken: legacyToken };
    }

    const apiTokenId = readString(credentials.apiTokenId);
    const apiTokenSecret = readString(credentials.apiTokenSecret);
    if (!apiTokenId || !apiTokenSecret) {
      throw new Error('Missing Proxmox API token credentials');
    }

    return {
      apiTokenId,
      apiTokenSecret,
    };
  }

  /**
   * Gets json.
   */
  async getJson(path: string, query?: Record<string, string | number | boolean | undefined>) {
    return this.requestJson('GET', path, query);
  }

  async postForm(
    path: string,
    body?: Record<string, string | number | boolean | null | undefined>,
  ) {
    return this.requestJson('POST', path, undefined, body);
  }

  /**
   * Handles post json.
   */
  async postJson(path: string, query?: Record<string, string | number | boolean | undefined>) {
    return this.requestJson('POST', path, query);
  }

  private async requestJson(
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    body?: Record<string, string | number | boolean | null | undefined>,
  ) {
    const url = buildRequestUrl(this.baseUrl, path, query);
    const encodedBody = encodeFormBody(body);
    if (this.config.allowInsecureTls && url.protocol === 'https:') {
      return this.requestWithInsecureTls(method, url, encodedBody);
    }

    const response = await this.fetchImpl(url, {
      method,
      headers: buildRequestHeaders(this.credentials, encodedBody),
      body: encodedBody,
    });
    const text = await response.text();
    return {
      status: response.status,
      data: parseBodyText(text),
    };
  }

  /**
   * Handles request with insecure tls.
   */
  private async requestWithInsecureTls(method: 'GET' | 'POST', url: URL, body?: string) {
    const port = url.port ? Number(url.port) : 443;
    const path = `${url.pathname}${url.search}`;

    return new Promise<{ status: number; data: unknown }>((resolve, reject) => {
      const request = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port,
          method,
          path,
          rejectUnauthorized: false,
          headers: buildRequestHeaders(this.credentials, body),
        },
        (response) => {
          let rawBody = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            rawBody += chunk;
          });
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              data: parseBodyText(rawBody),
            });
          });
        },
      );

      request.on('error', reject);
      if (body) {
        request.write(body);
      }
      request.end();
    });
  }
}

/**
 * Implements normalize base url.
 */
export function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * Implements read string.
 */
export function readString(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Implements read boolean.
 */
export function readBoolean(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return false;
}

/**
 * Builds authorization token.
 */
export function buildAuthorizationToken(credentials: ProxmoxCredentials) {
  if (credentials.apiToken) {
    return credentials.apiToken;
  }
  if (!credentials.apiTokenId || !credentials.apiTokenSecret) {
    throw new Error('Missing Proxmox API token credentials');
  }
  return `${credentials.apiTokenId}=${credentials.apiTokenSecret}`;
}

/**
 * Gets proxmox token id.
 */
export function getProxmoxTokenId(credentials: Record<string, unknown>) {
  const tokenId = readString(credentials.apiTokenId);
  if (tokenId) {
    return tokenId;
  }

  const legacyToken = readString(credentials.apiToken);
  if (!legacyToken) {
    return null;
  }

  const separatorIndex = legacyToken.indexOf('=');
  return separatorIndex > 0 ? legacyToken.slice(0, separatorIndex) : legacyToken;
}

/**
 * Implements extract proxmox api error.
 */
export function extractProxmoxApiError(data: unknown): string | null {
  const record = toRecord(data);
  if (!record) {
    return null;
  }

  const message = readString(record.message);
  if (message) {
    return message;
  }

  const errors = toRecord(record.errors);
  return errors ? JSON.stringify(errors) : null;
}

/**
 * Implements map proxmox fetch error.
 */
export function mapProxmoxFetchError(error: unknown) {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeMessage =
      cause && typeof cause === 'object' && 'message' in cause
        ? String((cause as { message?: unknown }).message ?? '')
        : '';
    const causeCode =
      cause && typeof cause === 'object' && 'code' in cause
        ? String((cause as { code?: unknown }).code ?? '')
        : '';
    const text = `${error.message} ${causeMessage} ${causeCode}`;
    if (
      text.includes('unable to verify the first certificate') ||
      text.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    ) {
      return 'TLS certificate verification failed. Use a valid certificate chain, or set allowInsecureTls=true for this integration (dev/trusted LAN only).';
    }
    return text.trim();
  }
  return 'Proxmox request failed';
}

/**
 * Implements to record.
 */
export function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Implements read number.
 */
export function readNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Parses unix timestamp.
 */
export function parseUnixTimestamp(value: unknown) {
  const parsed = readNumber(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }
  return new Date(parsed * 1000).toISOString();
}

/**
 * Builds request url.
 */
function buildRequestUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${baseUrl}${normalizedPath}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

/**
 * Parses body text.
 */
function parseBodyText(text: string): unknown {
  if (!text || text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

/**
 * Builds request headers.
 */
function buildRequestHeaders(credentials: ProxmoxCredentials, body?: string) {
  return {
    Authorization: `PVEAPIToken=${buildAuthorizationToken(credentials)}`,
    ...(body !== undefined
      ? {
          'Content-Type': 'application/x-www-form-urlencoded',
        }
      : {}),
  };
}

/**
 * Implements encode form body.
 */
function encodeFormBody(body?: Record<string, string | number | boolean | null | undefined>) {
  if (!body || Object.keys(body).length === 0) {
    return undefined;
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    params.set(key, String(value));
  }
  return params.toString();
}
