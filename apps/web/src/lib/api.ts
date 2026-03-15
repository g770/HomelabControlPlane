/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This utility module provides api helpers for the application.
 */
import { ApiClient } from '@homelab/shared';
import { apiBaseUrl } from './utils';
import { getToken } from './auth';

/**
 * Reuses one schema-aware API client instance across the web application.
 */
export const apiClient = new ApiClient({
  baseUrl: apiBaseUrl,
  getToken,
});

/**
 * Performs a JSON request with the current bearer token and normalizes API
 * error messages for UI callers.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    if (text) {
      let parsedMessage: string | null = null;
      try {
        // Prefer a backend-supplied message when the response body is JSON.
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed.message === 'string' && parsed.message.trim().length > 0) {
          parsedMessage = parsed.message;
        }
      } catch {
        // Fall back to the raw response body when the API did not return JSON.
      }
      if (parsedMessage) {
        throw new Error(parsedMessage);
      }
    }
    throw new Error(text || `Request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
