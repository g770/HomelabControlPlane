/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the settings page test UI behavior.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '@/pages/settings-page';
import { apiFetch } from '@/lib/api';
import type { ProxmoxIntegrationSummary } from '@/types/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Implements mock settings requests.
 */
function mockSettingsRequests(configured = true, integrations: ProxmoxIntegrationSummary[] = []) {
  let aiProviderState = {
    configured,
    model: 'gpt-5-mini',
    updatedAt: '2026-03-14T03:20:00.000Z',
  };
  let integrationsState = [...integrations];
  let themeState = {
    theme: {
      preset: 'default' as const,
      mode: 'dark' as const,
      palette: 'ocean' as const,
      style: 'soft' as const,
    },
    isCustom: false,
    updatedAt: null as string | null,
  };

  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/integrations' && (!init || !init.method)) {
      return integrationsState;
    }
    if (path === '/api/integrations' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        id?: string;
        name: string;
        enabled: boolean;
        baseUrl: string;
        apiTokenId: string;
        allowInsecureTls: boolean;
      };
      const integrationId = body.id ?? `integration-${integrationsState.length + 1}`;
      const nextIntegration = {
        id: integrationId,
        name: body.name,
        enabled: body.enabled,
        baseUrl: body.baseUrl,
        apiTokenId: body.apiTokenId,
        allowInsecureTls: body.allowInsecureTls,
        lastStatus: null,
        lastError: null,
        lastSyncAt: null,
      } satisfies ProxmoxIntegrationSummary;
      integrationsState = body.id
        ? integrationsState.map((integration) =>
            integration.id === body.id ? nextIntegration : integration,
          )
        : [...integrationsState, nextIntegration];
      return nextIntegration;
    }
    if (path.startsWith('/api/integrations/') && init?.method === 'DELETE') {
      const integrationId = path.replace('/api/integrations/', '');
      integrationsState = integrationsState.filter(
        (integration) => integration.id !== integrationId,
      );
      return {
        ok: true,
        integrationId,
        deletedServiceCount: 2,
        deletedServiceInstanceCount: 3,
        deletedHostCount: 1,
      };
    }
    if (path === '/api/notification-routes' && (!init || !init.method)) {
      return [];
    }
    if (path === '/api/ai/provider' && (!init || !init.method)) {
      return aiProviderState;
    }
    if (path === '/api/ai/provider' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body ?? '{}')) as { apiKey?: string | null };
      aiProviderState = {
        configured: body.apiKey !== null,
        model: 'gpt-5-mini',
        updatedAt: '2026-03-14T03:25:00.000Z',
      };
      return aiProviderState;
    }
    if (path === '/api/ai/personality' && (!init || !init.method)) {
      return {
        personality: '',
        isCustom: false,
        updatedAt: null,
      };
    }
    if (path === '/api/dashboard-agent/config' && (!init || !init.method)) {
      return {
        config: {
          enabled: true,
          intervalSec: 300,
          escalateCreateEvents: true,
          personality: '',
        },
        defaultPersonality: 'Investigate the highest-risk issues first.',
        nextScheduledRunAt: null,
        lastRunAt: null,
        isRunning: false,
        updatedAt: '2026-03-14T03:00:00.000Z',
      };
    }
    if (path === '/api/account/theme' && (!init || !init.method)) {
      return themeState;
    }
    if (path === '/api/account/theme' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        theme: {
          preset: 'default' | 'starship-ops' | 'custom';
          mode: 'dark' | 'light';
          palette: string;
          style: string;
        };
      };
      themeState = {
        theme: body.theme,
        isCustom: body.theme.preset === 'custom',
        updatedAt: '2026-03-14T03:30:00.000Z',
      };
      return themeState;
    }

    throw new Error(`Unexpected apiFetch call: ${path}`);
  });
}

/**
 * Renders the render page view.
 */
function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <SettingsPage />
    </QueryClientProvider>,
  );

  return { queryClient };
}

describe('SettingsPage integrations', () => {
  it('deletes an integration with confirmation and invalidates related queries', async () => {
    mockSettingsRequests(true, [
      {
        id: 'integration-1',
        name: 'Proxmox Lab',
        enabled: true,
        baseUrl: 'https://proxmox.local:8006',
        apiTokenId: 'root@pam!lab',
        allowInsecureTls: false,
      },
    ]);

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { queryClient } = renderPage();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    expect(await screen.findByText('Proxmox Integrations')).toBeInTheDocument();
    expect(await screen.findByText('Proxmox Lab')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(confirmSpy).toHaveBeenCalledWith(
      'Delete integration "Proxmox Lab"? This removes the integration, deletes sourced services and service instances, and attempts orphan-host cleanup. This cannot be undone.',
    );

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/integrations/integration-1', {
        method: 'DELETE',
        body: JSON.stringify({
          confirm: true,
        }),
      });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['integrations'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['hosts'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['services'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['checks'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['home-summary'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['events'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['alerts-incidents'] });
    });

    expect(
      await screen.findByText(
        'Integration "Proxmox Lab" deleted. Removed 2 services, 3 service instances, and 1 orphan host.',
      ),
    ).toBeInTheDocument();
  });

  it('does not issue a delete request when confirmation is canceled', async () => {
    mockSettingsRequests(true, [
      {
        id: 'integration-1',
        name: 'Proxmox Lab',
        enabled: true,
        baseUrl: 'https://proxmox.local:8006',
        apiTokenId: 'root@pam!lab',
        allowInsecureTls: false,
      },
    ]);

    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();

    expect(await screen.findByText('Proxmox Lab')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const deleteCall = vi
        .mocked(apiFetch)
        .mock.calls.find(
          (call) =>
            call[0] === '/api/integrations/integration-1' &&
            (call[1] as RequestInit | undefined)?.method === 'DELETE',
        );
      expect(deleteCall).toBeUndefined();
    });
  });

  it('submits explicit Proxmox integration fields instead of JSON blobs', async () => {
    mockSettingsRequests(true);

    const { queryClient } = renderPage();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    expect(await screen.findByText('Proxmox Integrations')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Integration Name'), {
      target: { value: 'Cluster Alpha' },
    });
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://cluster-alpha.local:8006' },
    });
    fireEvent.change(screen.getByLabelText('API Token ID'), {
      target: { value: 'root@pam!dashboard' },
    });
    fireEvent.change(screen.getByLabelText('API Token Secret'), {
      target: { value: 'secret-value' },
    });
    fireEvent.click(screen.getByLabelText('Allow insecure TLS'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Integration' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/integrations', {
        method: 'POST',
        body: JSON.stringify({
          confirm: true,
          name: 'Cluster Alpha',
          enabled: true,
          baseUrl: 'https://cluster-alpha.local:8006',
          apiTokenId: 'root@pam!dashboard',
          apiTokenSecret: 'secret-value',
          allowInsecureTls: true,
        }),
      });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['proxmox-integrations'] });
    });
    expect(
      await screen.findByText('Saved Proxmox integration "Cluster Alpha".'),
    ).toBeInTheDocument();
  });
});

describe('SettingsPage AI provider settings', () => {
  it('submits a replacement OpenAI API key with explicit confirmation', async () => {
    mockSettingsRequests(true);

    const { queryClient } = renderPage();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    expect(await screen.findByText('AI Provider')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('OpenAI API Key'), {
      target: { value: 'sk-live-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Key' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/ai/provider', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          apiKey: 'sk-live-123',
        }),
      });
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ai-provider'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ai-status'] });
    });

    expect(await screen.findByText('OpenAI API key saved.')).toBeInTheDocument();
  });

  it('clears the configured OpenAI API key', async () => {
    mockSettingsRequests(true);

    renderPage();

    expect(await screen.findByText('AI Provider')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Key' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/ai/provider', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          apiKey: null,
        }),
      });
    });

    expect(await screen.findByText('OpenAI API key cleared.')).toBeInTheDocument();
  });
});

describe('SettingsPage UI theme settings', () => {
  it('previews preset selection and saves it with explicit confirmation', async () => {
    mockSettingsRequests(true);

    renderPage();

    expect(await screen.findByText('UI Theme')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Starship Operations Console/i }));

    await waitFor(() => {
      expect(document.documentElement.dataset.themePreset).toBe('starship-ops');
      expect(document.documentElement.dataset.themePalette).toBe('starship-ops');
      expect(document.documentElement.dataset.themeStyle).toBe('industrial');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save Theme' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/account/theme', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          theme: {
            preset: 'starship-ops',
            mode: 'dark',
            palette: 'starship-ops',
            style: 'industrial',
          },
        }),
      });
    });
  });

  it('marks palette or style overrides as custom before saving', async () => {
    mockSettingsRequests(true);

    renderPage();

    expect(await screen.findByText('UI Theme')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Neon Grid Interface/i }));
    fireEvent.change(screen.getByLabelText('Theme Style'), {
      target: { value: 'lattice' },
    });

    await waitFor(() => {
      expect(document.documentElement.dataset.themePreset).toBe('custom');
      expect(document.documentElement.dataset.themeStyle).toBe('lattice');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save Theme' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/account/theme', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          theme: {
            preset: 'custom',
            mode: 'dark',
            palette: 'neon-grid',
            style: 'lattice',
          },
        }),
      });
    });
  });
});
