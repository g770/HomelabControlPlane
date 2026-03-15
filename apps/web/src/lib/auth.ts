/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This utility module provides auth helpers for the application.
 */
const TOKEN_KEY = 'homelab_token';

/**
 * Gets token.
 */
export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Sets token.
 */
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * Implements clear token.
 */
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}
