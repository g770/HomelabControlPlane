/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the check detail page test UI behavior.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MonitorDetailPage } from '@/pages/check-detail-page';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

/**
 * Renders the render monitor detail page view.
 */
function renderMonitorDetailPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/monitors/check-1']}>
        <Routes>
          <Route path="/monitors/:id" element={<MonitorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MonitorDetailPage history ordering and bounds', () => {
  it('renders only newest 20 history entries in descending order and keeps the list scrollable', async () => {
    const historyAscending = Array.from({ length: 25 }, (_, index) => ({
      id: `result-${index}`,
      status: `STATUS-${index}`,
      checkedAt: new Date(Date.UTC(2026, 2, 1, 0, index, 0)).toISOString(),
      latencyMs: index * 10,
      httpStatus: 200,
      errorMessage: null,
    }));

    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/checks/check-1' && (!init || !init.method)) {
        return {
          id: 'check-1',
          name: 'Demo Monitor',
          type: 'HTTP',
          target: 'https://example.local/health',
          intervalSec: 60,
          timeoutMs: 2000,
        };
      }
      if (path === '/api/checks/check-1/history?hours=24' && (!init || !init.method)) {
        return historyAscending;
      }
      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    const { container } = renderMonitorDetailPage();
    expect(await screen.findByText('Demo Monitor')).toBeInTheDocument();

    const statusNodes = screen.getAllByText(/STATUS-/);
    expect(statusNodes).toHaveLength(20);
    expect(statusNodes[0]).toHaveTextContent('STATUS-24');
    expect(statusNodes[statusNodes.length - 1]).toHaveTextContent('STATUS-5');
    expect(screen.queryByText('STATUS-4')).not.toBeInTheDocument();
    expect(screen.queryByText('STATUS-0')).not.toBeInTheDocument();

    const scrollContainer = container.querySelector('div.max-h-96.overflow-y-auto');
    expect(scrollContainer).toBeTruthy();
  });
});
