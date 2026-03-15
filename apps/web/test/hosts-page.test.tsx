/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the hosts page test UI behavior.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { HostsPage } from '@/pages/hosts-page';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

/**
 * Renders the render hosts page view.
 */
function renderHostsPage() {
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
        <HostsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Implements mock hosts and preferences.
 */
function mockHostsAndPreferences() {
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/hosts' && (!init || !init.method)) {
      return [
        {
          id: 'host-1',
          hostname: 'host-alpha',
          hostIp: '192.168.1.40',
          tags: ['edge'],
          hostType: 'MACHINE',
          status: 'OK',
          cpuPct: 12,
          memPct: 33,
          diskPct: 45,
          lastSeenAt: '2026-03-03T12:00:00.000Z',
          agentVersion: '1.2.3',
          agent: { revokedAt: null },
        },
      ];
    }

    if (path === '/api/account/preferences' && (!init || !init.method)) {
      return {
        preferences: {
          hiddenHostIds: [],
          discoverySubnets: ['192.168.1.0/24'],
          hostListColumns: {
            hiddenColumnIds: [],
            widths: [],
          },
          dashboardSuggestionsNotice: {
            dismissedFingerprint: null,
          },
          dashboardOrphanRecoveryNotice: {
            dismissedFingerprint: null,
          },
        },
        updatedAt: '2026-03-03T12:00:00.000Z',
      };
    }

    if (path === '/api/hosts/host-1/metadata' && init?.method === 'PUT') {
      return {
        hostId: 'host-1',
        hostName: 'host-alpha',
        tags: ['edge', 'rack-1'],
        hostType: 'MACHINE',
        updatedAt: '2026-03-03T12:01:00.000Z',
      };
    }

    if (path === '/api/account/preferences/host-list-columns' && init?.method === 'PUT') {
      return {
        preferences: {
          hiddenHostIds: [],
          discoverySubnets: ['192.168.1.0/24'],
          hostListColumns: {
            hiddenColumnIds: ['cpu'],
            widths: [],
          },
          dashboardSuggestionsNotice: {
            dismissedFingerprint: null,
          },
          dashboardOrphanRecoveryNotice: {
            dismissedFingerprint: null,
          },
        },
        updatedAt: '2026-03-03T12:00:01.000Z',
      };
    }

    throw new Error(`Unexpected apiFetch call: ${path}`);
  });
}

describe('HostsPage inline metadata editing and table preferences', () => {
  it('edits tags inline on the host list page', async () => {
    mockHostsAndPreferences();
    renderHostsPage();

    expect(await screen.findByText('host-alpha')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Tags/Type' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'edge' }));

    const tagInput = await screen.findByPlaceholderText('edge, proxmox, rack-1');
    fireEvent.change(tagInput, {
      target: { value: 'edge, rack-1' },
    });
    fireEvent.keyDown(tagInput, { key: 'Enter' });

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/hosts/host-1/metadata', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          tags: ['edge', 'rack-1'],
          hostType: 'MACHINE',
        }),
      });
    });
  });

  it('persists hide/show column changes through user preferences', async () => {
    mockHostsAndPreferences();
    renderHostsPage();

    expect(await screen.findByText('host-alpha')).toBeInTheDocument();

    const cpuToggle = screen.getByRole('checkbox', { name: 'CPU%' });
    fireEvent.click(cpuToggle);

    await waitFor(() => {
      const mutationCall = vi
        .mocked(apiFetch)
        .mock.calls.find(
          (call) =>
            call[0] === '/api/account/preferences/host-list-columns' && call[1]?.method === 'PUT',
        );
      expect(mutationCall).toBeTruthy();
      const body = JSON.parse(String(mutationCall?.[1]?.body ?? '{}')) as {
        confirm?: boolean;
        hostListColumns?: {
          hiddenColumnIds?: string[];
          widths?: Array<{ id: string; widthPx: number }>;
        };
      };
      expect(body.confirm).toBe(true);
      expect(body.hostListColumns?.hiddenColumnIds).toContain('cpu');
      expect(Array.isArray(body.hostListColumns?.widths)).toBe(true);
    });
  });
});
