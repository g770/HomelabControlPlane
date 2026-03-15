/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the links page test UI behavior.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { LinksPage } from '@/pages/links-page';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

/**
 * Builds preferences.
 */
function buildPreferences(overrides?: {
  dashboardSuggestionsNoticeDismissedFingerprint?: string | null;
  dashboardOrphanRecoveryNoticeDismissedFingerprint?: string | null;
}) {
  return {
    preferences: {
      hiddenHostIds: [],
      discoverySubnets: ['192.168.1.0/24'],
      hostListColumns: {
        hiddenColumnIds: [],
        widths: [],
      },
      dashboardSuggestionsNotice: {
        dismissedFingerprint: overrides?.dashboardSuggestionsNoticeDismissedFingerprint ?? null,
      },
      dashboardOrphanRecoveryNotice: {
        dismissedFingerprint: overrides?.dashboardOrphanRecoveryNoticeDismissedFingerprint ?? null,
      },
    },
    updatedAt: '2026-03-03T12:00:00.000Z',
  };
}

/**
 * Builds dashboard response.
 */
function buildDashboardResponse() {
  return {
    dashboard: {
      version: 1,
      settings: {
        columns: 4,
        tileSize: 'md',
        defaultOpenInNewTab: true,
      },
      groups: [
        {
          id: 'favorites',
          title: 'Favorites',
          color: 'slate',
          collapsed: false,
          tiles: [],
          widgets: [],
        },
      ],
    },
    knownIcons: [{ id: 'globe', label: 'Generic Service' }],
    groupColors: ['slate'],
  };
}

/**
 * Renders the render links page view.
 */
function renderLinksPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <LinksPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LinksPage notices', () => {
  it('shows dismissible notice for unseen suggested links', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/links/dashboard' && (!init || !init.method)) {
        return buildDashboardResponse();
      }

      if (path === '/api/links/suggestions' && (!init || !init.method)) {
        return {
          generatedAt: '2026-03-03T12:00:00.000Z',
          suggestions: [
            {
              id: 's-1',
              serviceId: 'svc-1',
              serviceName: 'Grafana',
              title: 'Grafana',
              url: 'http://grafana.local:3000',
              description: 'Suggested from discovery.',
              icon: 'chart',
              groupHint: 'Monitoring',
              confidence: 95,
              source: 'endpoint',
            },
          ],
          knownIcons: [{ id: 'chart', label: 'Observability' }],
        };
      }

      if (path === '/api/agent-recovery/summary' && (!init || !init.method)) {
        return {
          pendingApprovalCount: 0,
          pendingApprovalFingerprint: null,
          pendingClaimsPreview: [],
        };
      }

      if (path === '/api/account/preferences' && (!init || !init.method)) {
        return buildPreferences();
      }

      if (
        path === '/api/account/preferences/dashboard-suggestions-notice' &&
        init?.method === 'PUT'
      ) {
        return buildPreferences({
          dashboardSuggestionsNoticeDismissedFingerprint: 'fnv1a-deadbeef',
        });
      }

      if (path === '/api/hosts' && (!init || !init.method)) {
        return [];
      }

      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    renderLinksPage();

    expect(await screen.findByText('New suggested links are available.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => {
      const call = vi
        .mocked(apiFetch)
        .mock.calls.find(
          (entry) =>
            entry[0] === '/api/account/preferences/dashboard-suggestions-notice' &&
            entry[1]?.method === 'PUT',
        );
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call?.[1]?.body ?? '{}')) as {
        confirm?: boolean;
        dismissedFingerprint?: string;
      };
      expect(body.confirm).toBe(true);
      expect(typeof body.dismissedFingerprint).toBe('string');
      expect((body.dismissedFingerprint ?? '').length).toBeGreaterThan(0);
    });
  });

  it('shows and dismisses the orphan-recovery dashboard notice, then re-shows it when the fingerprint changes', async () => {
    let orphanFingerprint = 'fnv1a-orphan-a';
    let dismissedOrphanFingerprint: string | null = null;

    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/links/dashboard' && (!init || !init.method)) {
        return buildDashboardResponse();
      }

      if (path === '/api/links/suggestions' && (!init || !init.method)) {
        return {
          generatedAt: '2026-03-03T12:00:00.000Z',
          suggestions: [],
          knownIcons: [],
        };
      }

      if (path === '/api/agent-recovery/summary' && (!init || !init.method)) {
        return {
          pendingApprovalCount: 2,
          pendingApprovalFingerprint: orphanFingerprint,
          pendingClaimsPreview: [
            {
              id: 'claim-1',
              label: 'rack-agent-1',
              hostname: 'host-alpha',
              lastSeenAt: '2026-03-12T12:05:00.000Z',
            },
            {
              id: 'claim-2',
              label: 'host-beta',
              hostname: 'host-beta',
              lastSeenAt: '2026-03-12T12:06:00.000Z',
            },
          ],
        };
      }

      if (path === '/api/account/preferences' && (!init || !init.method)) {
        return buildPreferences({
          dashboardOrphanRecoveryNoticeDismissedFingerprint: dismissedOrphanFingerprint,
        });
      }

      if (
        path === '/api/account/preferences/dashboard-orphan-recovery-notice' &&
        init?.method === 'PUT'
      ) {
        const payload = JSON.parse(String(init.body ?? '{}')) as {
          dismissedFingerprint?: string | null;
        };
        dismissedOrphanFingerprint = payload.dismissedFingerprint ?? null;
        return buildPreferences({
          dashboardOrphanRecoveryNoticeDismissedFingerprint: dismissedOrphanFingerprint,
        });
      }

      if (path === '/api/hosts' && (!init || !init.method)) {
        return [];
      }

      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    renderLinksPage();

    expect(await screen.findByText('Orphaned agents are waiting for review.')).toBeInTheDocument();
    expect(screen.getByText(/2 pending recovery claims detected\./)).toBeInTheDocument();
    expect(screen.getByText(/Review rack-agent-1, host-beta\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review Claims' })).toHaveAttribute(
      'href',
      '/agent-management',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => {
      const call = vi
        .mocked(apiFetch)
        .mock.calls.find(
          (entry) =>
            entry[0] === '/api/account/preferences/dashboard-orphan-recovery-notice' &&
            entry[1]?.method === 'PUT',
        );
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body ?? '{}'))).toEqual({
        confirm: true,
        dismissedFingerprint: 'fnv1a-orphan-a',
      });
    });

    orphanFingerprint = 'fnv1a-orphan-b';
    cleanup();

    renderLinksPage();

    expect(await screen.findByText('Orphaned agents are waiting for review.')).toBeInTheDocument();
  });
});
