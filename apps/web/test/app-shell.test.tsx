/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the app shell test UI behavior.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { defaultSidebarNavigationOrderedItemIds, type SidebarNavItemId } from '@homelab/shared';
import { AppShell } from '@/components/app-shell';
import { apiFetch } from '@/lib/api';

const useAuthMock = vi.fn();
let desktopViewport = true;

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const basePreferences = {
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
};

/**
 * Builds preferences response.
 */
function buildPreferencesResponse(orderedItemIds?: SidebarNavItemId[]) {
  return {
    preferences: {
      ...basePreferences,
      ...(orderedItemIds
        ? {
            sidebarNavigation: {
              orderedItemIds,
            },
          }
        : {}),
    },
    updatedAt: '2026-03-08T12:00:00.000Z',
  };
}

/**
 * Implements install api mock.
 */
function installApiMock(options?: {
  initialOrderedItemIds?: SidebarNavItemId[];
  omitSidebarNavigation?: boolean;
  sidebarNavigationSaveError?: string;
  proxmoxIntegrations?: Array<{ id: string; enabled: boolean; name: string }>;
}) {
  let orderedItemIds =
    options?.initialOrderedItemIds ?? defaultSidebarNavigationOrderedItemIds.slice();

  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/hosts') {
      return [];
    }

    if (path === '/api/account/theme') {
      return {
        theme: { preset: 'default', mode: 'dark', palette: 'ocean', style: 'soft' },
        isCustom: false,
        updatedAt: null,
      };
    }

    if (path === '/api/account/preferences' && (!init || !init.method)) {
      return buildPreferencesResponse(options?.omitSidebarNavigation ? undefined : orderedItemIds);
    }

    if (path === '/api/proxmox/integrations') {
      return options?.proxmoxIntegrations ?? [];
    }

    if (path === '/api/account/preferences/sidebar-navigation' && init?.method === 'PUT') {
      if (options?.sidebarNavigationSaveError) {
        throw new Error(options.sidebarNavigationSaveError);
      }

      const payload = JSON.parse(String(init.body)) as {
        confirm: true;
        orderedItemIds: SidebarNavItemId[];
      };
      orderedItemIds = payload.orderedItemIds.slice();
      return buildPreferencesResponse(orderedItemIds);
    }

    throw new Error(`Unexpected apiFetch call: ${path}`);
  });
}

/**
 * Renders the render shell view.
 */
function renderShell(initialPath = '/dashboard') {
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
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route path="dashboard" element={<div>Dashboard page</div>} />
            <Route path="dashboard-agent" element={<div>Dashboard Agent page</div>} />
            <Route path="hosts" element={<div>Hosts page</div>} />
            <Route path="proxmox" element={<div>Proxmox page</div>} />
            <Route path="monitors" element={<div>Monitors page</div>} />
            <Route path="alerts" element={<div>Alerts page</div>} />
            <Route path="service-discovery" element={<div>Discovery page</div>} />
            <Route path="agent-management" element={<div>Agent Management page</div>} />
            <Route path="ai" element={<div>AI page</div>} />
            <Route path="settings" element={<div>Settings page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Implements current nav labels.
 */
function currentNavLabels() {
  const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
  return within(nav)
    .queryAllByRole('link')
    .map((link) => link.textContent?.trim() ?? '');
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  desktopViewport = true;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: desktopViewport,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  useAuthMock.mockReturnValue({
    user: {
      displayName: 'Operator One',
    },
    logout: vi.fn(),
  });
});

describe('AppShell sidebar navigation ordering', () => {
  it('applies the persisted preset-aware theme when the shell loads', async () => {
    installApiMock();

    renderShell();

    await waitFor(() => {
      expect(document.documentElement.dataset.themePreset).toBe('default');
      expect(document.documentElement.dataset.themePalette).toBe('ocean');
      expect(document.documentElement.dataset.themeStyle).toBe('soft');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
  });

  it('renders the default order when no saved sidebar navigation exists', async () => {
    installApiMock({ omitSidebarNavigation: true });

    renderShell();

    await waitFor(() => {
      expect(currentNavLabels()).toEqual([
        'Dashboard',
        'Dashboard Agent',
        'Hosts',
        'Network Monitors',
        'Alerts',
        'Service Discovery',
        'Agent Management',
        'AI',
        'Settings',
      ]);
    });
  });

  it('shows inline drag handles on desktop and saves immediately after keyboard reordering', async () => {
    installApiMock();

    renderShell();

    await waitFor(() => {
      expect(currentNavLabels()).toEqual([
        'Dashboard',
        'Dashboard Agent',
        'Hosts',
        'Network Monitors',
        'Alerts',
        'Service Discovery',
        'Agent Management',
        'AI',
        'Settings',
      ]);
    });

    expect(screen.queryByRole('button', { name: 'Reorder tabs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save order' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drag Dashboard' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Drag Hosts' }), {
      key: 'ArrowUp',
    });

    await waitFor(() => {
      expect(
        vi
          .mocked(apiFetch)
          .mock.calls.filter(
            (call) =>
              call[0] === '/api/account/preferences/sidebar-navigation' &&
              call[1]?.method === 'PUT',
          ),
      ).toHaveLength(1);
    });

    const saveCall = vi
      .mocked(apiFetch)
      .mock.calls.find(
        (call) =>
          call[0] === '/api/account/preferences/sidebar-navigation' && call[1]?.method === 'PUT',
      );

    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
      confirm: true,
      orderedItemIds: [
        'dashboard',
        'hosts',
        'dashboard-agent',
        'proxmox',
        'network-monitors',
        'alerts',
        'service-discovery',
        'agent-management',
        'ai',
        'settings',
      ],
    });

    await waitFor(() => {
      expect(currentNavLabels()).toEqual([
        'Dashboard',
        'Hosts',
        'Dashboard Agent',
        'Network Monitors',
        'Alerts',
        'Service Discovery',
        'Agent Management',
        'AI',
        'Settings',
      ]);
    });
  });

  it('rolls back to the previous saved order and shows an inline error when a save fails', async () => {
    installApiMock({ sidebarNavigationSaveError: 'Could not save sidebar order.' });

    renderShell();

    await waitFor(() => {
      expect(currentNavLabels()).toEqual([
        'Dashboard',
        'Dashboard Agent',
        'Hosts',
        'Network Monitors',
        'Alerts',
        'Service Discovery',
        'Agent Management',
        'AI',
        'Settings',
      ]);
    });

    fireEvent.keyDown(screen.getByRole('button', { name: 'Drag Hosts' }), {
      key: 'ArrowUp',
    });

    await waitFor(() => {
      expect(screen.getByText('Could not save sidebar order.')).toBeInTheDocument();
      expect(currentNavLabels()).toEqual([
        'Dashboard',
        'Dashboard Agent',
        'Hosts',
        'Network Monitors',
        'Alerts',
        'Service Discovery',
        'Agent Management',
        'AI',
        'Settings',
      ]);
    });
  });

  it('normalizes stale saved order and persists immediate drag-drop changes', async () => {
    installApiMock({
      initialOrderedItemIds: [
        'hosts',
        'dashboard-agent',
        'hosts',
        'dashboard',
      ] as SidebarNavItemId[],
    });

    renderShell();

    await waitFor(() => {
      expect(currentNavLabels()).toEqual([
        'Hosts',
        'Dashboard Agent',
        'Dashboard',
        'Network Monitors',
        'Alerts',
        'Service Discovery',
        'Agent Management',
        'AI',
        'Settings',
      ]);
    });

    fireEvent.dragStart(screen.getByRole('button', { name: 'Drag Settings' }), {
      dataTransfer: {
        effectAllowed: 'move',
        setData: vi.fn(),
      },
    });
    fireEvent.dragOver(document.querySelector('[data-sidebar-nav-id="ai"]') as Element);
    fireEvent.drop(document.querySelector('[data-sidebar-nav-id="ai"]') as Element);

    await waitFor(() => {
      expect(currentNavLabels()).toEqual([
        'Hosts',
        'Dashboard Agent',
        'Dashboard',
        'Network Monitors',
        'Alerts',
        'Service Discovery',
        'Agent Management',
        'Settings',
        'AI',
      ]);
    });

    const saveCall = vi
      .mocked(apiFetch)
      .mock.calls.find(
        (call) =>
          call[0] === '/api/account/preferences/sidebar-navigation' && call[1]?.method === 'PUT',
      );

    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
      confirm: true,
      orderedItemIds: [
        'hosts',
        'dashboard-agent',
        'dashboard',
        'proxmox',
        'network-monitors',
        'alerts',
        'service-discovery',
        'agent-management',
        'settings',
        'ai',
      ],
    });
  });

  it('does not render sidebar drag handles when the viewport is below desktop width', async () => {
    desktopViewport = false;
    installApiMock();

    renderShell();

    await waitFor(() => {
      expect(currentNavLabels()).toEqual([
        'Dashboard',
        'Dashboard Agent',
        'Hosts',
        'Network Monitors',
        'Alerts',
        'Service Discovery',
        'Agent Management',
        'AI',
        'Settings',
      ]);
    });

    expect(screen.queryByRole('button', { name: 'Drag Dashboard' })).not.toBeInTheDocument();
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.some(
          (call) =>
            call[0] === '/api/account/preferences/sidebar-navigation' && call[1]?.method === 'PUT',
        ),
    ).toBe(false);
  });

  it('shows the Proxmox tab when an enabled Proxmox integration exists', async () => {
    installApiMock({
      proxmoxIntegrations: [{ id: 'prox-1', enabled: true, name: 'Proxmox Lab' }],
    });

    renderShell();

    await waitFor(() => {
      expect(currentNavLabels()).toEqual([
        'Dashboard',
        'Dashboard Agent',
        'Hosts',
        'Proxmox',
        'Network Monitors',
        'Alerts',
        'Service Discovery',
        'Agent Management',
        'AI',
        'Settings',
      ]);
    });
  });
});
