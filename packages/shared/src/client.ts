/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the client logic for the repository.
 */
import {
  authChangePasswordSchema,
  authSetupRequestSchema,
  authSetupStatusSchema,
  aiChatRequestSchema,
  createCheckSchema,
  createToolProposalSchema,
  loginRequestSchema,
  loginResponseSchema,
  userSchema,
} from './schemas';

/**
 * Configures how the shared API client reaches the control plane and reads auth state.
 */
export type ApiClientOptions = {
  baseUrl: string;
  getToken?: () => string | null;
};

/**
 * Provides typed helpers for the browser-facing control-plane endpoints.
 */
export class ApiClient {
  /**
   * Creates the instance and stores the dependencies required by this type.
   */
  constructor(private readonly options: ApiClientOptions) {}

  /**
   * Executes a JSON request, attaches auth when available, and validates typed responses.
   */
  private async request<T>(
    path: string,
    init: RequestInit = {},
    validator?: { parse: (value: unknown) => T },
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    const token = this.options.getToken?.();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const response = await fetch(`${this.options.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API ${response.status}: ${errText}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const data = (await response.json()) as unknown;
    return validator ? validator.parse(data) : (data as T);
  }

  /**
   * Authenticates the current user with the admin password flow.
   */
  async login(input: unknown) {
    const payload = loginRequestSchema.parse(input);
    return this.request(
      '/api/auth/login',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      loginResponseSchema,
    );
  }

  /**
   * Returns whether first-run admin setup is still required.
   */
  async getSetupStatus() {
    return this.request('/api/auth/setup-status', { method: 'GET' }, authSetupStatusSchema);
  }

  /**
   * Completes the first-run admin setup flow.
   */
  async setupAdmin(input: unknown) {
    const payload = authSetupRequestSchema.parse(input);
    return this.request(
      '/api/auth/setup',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      loginResponseSchema,
    );
  }

  /**
   * Submits an authenticated password rotation request.
   */
  async changePassword(input: unknown) {
    const payload = authChangePasswordSchema.parse(input);
    return this.request('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /**
   * Loads the current authenticated user profile.
   */
  async me() {
    return this.request('/api/me', { method: 'GET' }, userSchema);
  }

  /**
   * Creates a new monitor or check definition.
   */
  async createCheck(input: unknown) {
    const payload = createCheckSchema.parse(input);
    return this.request('/api/checks', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /**
   * Sends a chat prompt to the AI assistant endpoint.
   */
  async aiChat(input: unknown) {
    const payload = aiChatRequestSchema.parse(input);
    return this.request('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /**
   * Creates a tool proposal request for approval workflows.
   */
  async createToolProposal(input: unknown) {
    const payload = createToolProposalSchema.parse(input);
    return this.request('/api/tool-proposals', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }
}
