/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the host metadata editor test UI behavior.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HostMetadataEditor } from '@/components/host-metadata-editor';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

describe('HostMetadataEditor', () => {
  it('submits host metadata updates with explicit confirmation', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      hostId: 'host-1',
      hostName: 'host-alpha',
      tags: ['edge', 'rack-1'],
      hostType: 'CONTAINER',
      updatedAt: '2026-03-03T12:00:00.000Z',
    });

    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <HostMetadataEditor
          hostId="host-1"
          hostName="host-alpha"
          initialTags={['edge']}
          initialHostType="MACHINE"
        />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText('edge, proxmox, rack-1'), {
      target: { value: 'edge, rack-1' },
    });
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'CONTAINER' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Metadata' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/hosts/host-1/metadata', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          tags: ['edge', 'rack-1'],
          hostType: 'CONTAINER',
        }),
      });
    });
  });
});
