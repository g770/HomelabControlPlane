/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the proxmox page test UI behavior.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ProxmoxPage } from '@/pages/proxmox-page';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Implements install api mock.
 */
function installApiMock() {
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/proxmox/integrations') {
      return [
        {
          id: 'prox-1',
          name: 'Proxmox Lab',
          type: 'PROXMOX',
          enabled: true,
          baseUrl: 'https://proxmox.local:8006',
          apiTokenId: 'root@pam!dashboard',
          allowInsecureTls: false,
          lastStatus: 'ok',
          lastError: null,
          lastSyncAt: '2026-03-14T03:00:00.000Z',
        },
      ];
    }

    if (path === '/api/proxmox/integrations/prox-1/guests') {
      return {
        integration: {
          id: 'prox-1',
          name: 'Proxmox Lab',
          type: 'PROXMOX',
          enabled: true,
          baseUrl: 'https://proxmox.local:8006',
          apiTokenId: 'root@pam!dashboard',
          allowInsecureTls: false,
          lastStatus: 'ok',
          lastError: null,
          lastSyncAt: '2026-03-14T03:00:00.000Z',
        },
        summary: {
          total: 2,
          running: 1,
          stopped: 1,
          qemu: 1,
          lxc: 1,
        },
        filters: {
          nodes: ['pve-1', 'pve-2'],
        },
        guests: [
          {
            id: 'qemu:101',
            kind: 'qemu',
            vmid: 101,
            name: 'alpha',
            node: 'pve-1',
            status: 'running',
            template: false,
            locked: false,
            tags: ['production'],
            cpu: 0.124,
            maxCpu: 4,
            memoryBytes: 4 * 1024 * 1024 * 1024,
            maxMemoryBytes: 8 * 1024 * 1024 * 1024,
            diskBytes: 32 * 1024 * 1024 * 1024,
            maxDiskBytes: 64 * 1024 * 1024 * 1024,
            uptimeSeconds: 3600,
          },
          {
            id: 'lxc:202',
            kind: 'lxc',
            vmid: 202,
            name: 'db',
            node: 'pve-2',
            status: 'stopped',
            template: false,
            locked: false,
            tags: ['database'],
            cpu: 0,
            maxCpu: 2,
            memoryBytes: 2 * 1024 * 1024 * 1024,
            maxMemoryBytes: 4 * 1024 * 1024 * 1024,
            diskBytes: 16 * 1024 * 1024 * 1024,
            maxDiskBytes: 32 * 1024 * 1024 * 1024,
            uptimeSeconds: 0,
          },
        ],
      };
    }

    if (path === '/api/proxmox/integrations/prox-1/guests/qemu/101') {
      return {
        integration: {
          id: 'prox-1',
          name: 'Proxmox Lab',
          type: 'PROXMOX',
          enabled: true,
          baseUrl: 'https://proxmox.local:8006',
          apiTokenId: 'root@pam!dashboard',
          allowInsecureTls: false,
        },
        guest: {
          id: 'qemu:101',
          kind: 'qemu',
          vmid: 101,
          name: 'alpha',
          node: 'pve-1',
          status: 'running',
          template: false,
          locked: false,
          tags: ['production'],
          cpu: 0.124,
          maxCpu: 4,
          memoryBytes: 4 * 1024 * 1024 * 1024,
          maxMemoryBytes: 8 * 1024 * 1024 * 1024,
          diskBytes: 32 * 1024 * 1024 * 1024,
          maxDiskBytes: 64 * 1024 * 1024 * 1024,
          uptimeSeconds: 3600,
          rawStatus: {
            status: 'running',
          },
          rawConfig: {
            name: 'alpha',
            memory: 4096,
            cores: 4,
          },
          displayConfig: [
            { label: 'Name', value: 'alpha' },
            { label: 'Memory', value: '4096 MiB' },
            { label: 'Cores', value: '4' },
          ],
        },
      };
    }

    if (path === '/api/proxmox/integrations/prox-1/guests/lxc/202') {
      return {
        integration: {
          id: 'prox-1',
          name: 'Proxmox Lab',
          type: 'PROXMOX',
          enabled: true,
          baseUrl: 'https://proxmox.local:8006',
          apiTokenId: 'root@pam!dashboard',
          allowInsecureTls: false,
        },
        guest: {
          id: 'lxc:202',
          kind: 'lxc',
          vmid: 202,
          name: 'db',
          node: 'pve-2',
          status: 'stopped',
          template: false,
          locked: false,
          tags: ['database'],
          cpu: 0,
          maxCpu: 2,
          memoryBytes: 2 * 1024 * 1024 * 1024,
          maxMemoryBytes: 4 * 1024 * 1024 * 1024,
          diskBytes: 16 * 1024 * 1024 * 1024,
          maxDiskBytes: 32 * 1024 * 1024 * 1024,
          uptimeSeconds: 0,
          rawStatus: {
            status: 'stopped',
          },
          rawConfig: {
            hostname: 'db',
            memory: 2048,
          },
          displayConfig: [
            { label: 'Hostname', value: 'db' },
            { label: 'Memory', value: '2048 MiB' },
          ],
        },
      };
    }

    if (path === '/api/proxmox/integrations/prox-1/guests/qemu/101/tasks') {
      return {
        integration: {
          id: 'prox-1',
          name: 'Proxmox Lab',
          type: 'PROXMOX',
          enabled: true,
          baseUrl: 'https://proxmox.local:8006',
          apiTokenId: 'root@pam!dashboard',
          allowInsecureTls: false,
        },
        tasks: [
          {
            upid: 'UPID:qemu:1',
            node: 'pve-1',
            status: 'running',
            type: 'qmshutdown',
            startedAt: '2026-03-14T03:10:00.000Z',
            endedAt: null,
          },
        ],
      };
    }

    if (path === '/api/proxmox/integrations/prox-1/guests/lxc/202/tasks') {
      return {
        integration: {
          id: 'prox-1',
          name: 'Proxmox Lab',
          type: 'PROXMOX',
          enabled: true,
          baseUrl: 'https://proxmox.local:8006',
          apiTokenId: 'root@pam!dashboard',
          allowInsecureTls: false,
        },
        tasks: [
          {
            upid: 'UPID:lxc:1',
            node: 'pve-2',
            status: 'stopped',
            type: 'pctstart',
            startedAt: '2026-03-14T02:10:00.000Z',
            endedAt: '2026-03-14T02:12:00.000Z',
          },
        ],
      };
    }

    if (
      path === '/api/proxmox/integrations/prox-1/guests/qemu/101/actions/shutdown' &&
      init?.method === 'POST'
    ) {
      return {
        ok: true,
        action: 'shutdown',
        upid: 'UPID:qemu:1',
      };
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
      <MemoryRouter>
        <ProxmoxPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { queryClient };
}

describe('ProxmoxPage', () => {
  it('loads inventory and switches guest detail when a different row is selected', async () => {
    installApiMock();

    renderPage();

    expect(await screen.findByText('Guest Inventory')).toBeInTheDocument();
    expect(await screen.findByText('alpha')).toBeInTheDocument();
    expect(await screen.findByText('db')).toBeInTheDocument();

    await screen.findByText('QEMU #101 on pve-1');
    fireEvent.click(screen.getByText('db'));

    expect(await screen.findByText('LXC #202 on pve-2')).toBeInTheDocument();
    expect(screen.getByDisplayValue(/"hostname": "db"/)).toBeInTheDocument();
  });

  it('confirms and submits lifecycle actions for the selected guest', async () => {
    installApiMock();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage();

    expect(await screen.findByText('QEMU #101 on pve-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Shutdown' }));

    expect(confirmSpy).toHaveBeenCalledWith('Send a graceful shutdown request to guest "alpha"?');

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/proxmox/integrations/prox-1/guests/qemu/101/actions/shutdown',
        {
          method: 'POST',
          body: JSON.stringify({
            confirm: true,
          }),
        },
      );
    });

    expect(await screen.findByText('Shutdown requested for alpha.')).toBeInTheDocument();
  });
});
