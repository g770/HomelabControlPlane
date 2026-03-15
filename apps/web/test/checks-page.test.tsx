/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the checks page test UI behavior.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonitorsPage } from '@/pages/checks-page';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

/**
 * Creates deferred for the surrounding workflow.
 */
function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

/**
 * Implements suggestions response.
 */
function suggestionsResponse() {
  return {
    generatedAt: '2026-03-03T12:00:00.000Z',
    aiEnabled: false,
    generatedByAi: false,
    warnings: [],
    suggestions: [],
  };
}

/**
 * Renders the render monitors page view.
 */
function renderMonitorsPage() {
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
        <MonitorsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MonitorsPage form help text and mutation pending states', () => {
  it('renders helper text below each monitor form field', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/checks' && (!init || !init.method)) {
        return [];
      }
      if (path === '/api/hosts' && (!init || !init.method)) {
        return [];
      }
      if (path === '/api/services' && (!init || !init.method)) {
        return [];
      }
      if (path === '/api/checks/ai/suggestions' && (!init || !init.method)) {
        return suggestionsResponse();
      }
      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    renderMonitorsPage();

    await screen.findByPlaceholderText('Monitor name');

    expect(
      screen.getByText('Friendly name shown in monitor lists and alerts.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Select protocol: HTTP, TCP, or ICMP reachability checks.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('HTTP uses URL, TCP uses host:port, ICMP uses host or IP.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Run frequency in seconds (10-3600).')).toBeInTheDocument();
    expect(
      screen.getByText('Maximum request time in milliseconds (100-30000).'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Expected HTTP response code (100-599), or leave blank.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Optional body text required for HTTP checks to pass.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Associate this monitor with a host for context and filtering.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Associate this monitor with a service for context and filtering.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Disable to keep configuration without running scheduled checks.'),
    ).toBeInTheDocument();
  });

  it('re-enables create button after create succeeds even when invalidation refetch is still pending', async () => {
    const createRequest = createDeferred<Record<string, unknown>>();
    const checksRefetch = createDeferred<Array<Record<string, unknown>>>();
    const suggestionsRefetch = createDeferred<Record<string, unknown>>();
    let checksGetCount = 0;
    let suggestionsGetCount = 0;

    vi.mocked(apiFetch).mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/checks' && init?.method === 'POST') {
        return createRequest.promise;
      }
      if (path === '/api/checks' && (!init || !init.method)) {
        checksGetCount += 1;
        return checksGetCount === 1 ? Promise.resolve([]) : checksRefetch.promise;
      }
      if (path === '/api/checks/ai/suggestions' && (!init || !init.method)) {
        suggestionsGetCount += 1;
        return suggestionsGetCount === 1
          ? Promise.resolve(suggestionsResponse())
          : suggestionsRefetch.promise;
      }
      if (path === '/api/hosts' && (!init || !init.method)) {
        return Promise.resolve([]);
      }
      if (path === '/api/services' && (!init || !init.method)) {
        return Promise.resolve([]);
      }
      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    renderMonitorsPage();

    await screen.findByRole('button', { name: 'Create Monitor' });
    fireEvent.change(screen.getByPlaceholderText('Monitor name'), {
      target: { value: 'Grafana Health' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Monitor' }));

    await waitFor(() => {
      const postCall = vi
        .mocked(apiFetch)
        .mock.calls.find((call) => call[0] === '/api/checks' && call[1]?.method === 'POST');
      expect(postCall).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();

    createRequest.resolve({ id: 'check-new' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Monitor' })).not.toBeDisabled();
    });
    await waitFor(() => {
      expect(checksGetCount).toBeGreaterThan(1);
      expect(suggestionsGetCount).toBeGreaterThan(1);
    });
    expect(screen.getByRole('button', { name: 'Create Monitor' })).not.toBeDisabled();

    checksRefetch.resolve([]);
    suggestionsRefetch.resolve(suggestionsResponse());
  });

  it('re-enables delete buttons after delete succeeds even when invalidation refetch is still pending', async () => {
    const monitor = {
      id: 'check-1',
      name: 'Demo HTTP Monitor',
      type: 'HTTP',
      target: 'https://example.local/health',
      expectedStatus: 200,
      intervalSec: 60,
      timeoutMs: 2000,
      keyword: null,
      enabled: true,
      hostId: null,
      serviceId: null,
      host: null,
      service: null,
      results: [{ status: 'UP' }],
    };
    const deleteRequest = createDeferred<Record<string, unknown>>();
    const checksRefetch = createDeferred<Array<Record<string, unknown>>>();
    const suggestionsRefetch = createDeferred<Record<string, unknown>>();
    let checksGetCount = 0;
    let suggestionsGetCount = 0;

    vi.mocked(apiFetch).mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/checks/check-1' && init?.method === 'DELETE') {
        return deleteRequest.promise;
      }
      if (path === '/api/checks' && (!init || !init.method)) {
        checksGetCount += 1;
        return checksGetCount === 1 ? Promise.resolve([monitor]) : checksRefetch.promise;
      }
      if (path === '/api/checks/ai/suggestions' && (!init || !init.method)) {
        suggestionsGetCount += 1;
        return suggestionsGetCount === 1
          ? Promise.resolve(suggestionsResponse())
          : suggestionsRefetch.promise;
      }
      if (path === '/api/hosts' && (!init || !init.method)) {
        return Promise.resolve([]);
      }
      if (path === '/api/services' && (!init || !init.method)) {
        return Promise.resolve([]);
      }
      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderMonitorsPage();

    await screen.findByText('Demo HTTP Monitor');
    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(deleteButton);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    });

    deleteRequest.resolve({ ok: true });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete' })).not.toBeDisabled();
    });
    await waitFor(() => {
      expect(checksGetCount).toBeGreaterThan(1);
      expect(suggestionsGetCount).toBeGreaterThan(1);
    });
    expect(screen.getByRole('button', { name: 'Delete' })).not.toBeDisabled();

    checksRefetch.resolve([monitor]);
    suggestionsRefetch.resolve(suggestionsResponse());
  });
});
