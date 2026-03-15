/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the alerts page test UI behavior.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertsPage } from '@/pages/alerts-page';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const catalogResponse = {
  comparators: ['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ'],
  reducers: ['latest', 'avg', 'min', 'max'],
  hostMetrics: [
    { id: 'cpuPct', label: 'CPU %' },
    { id: 'memPct', label: 'Memory %' },
  ],
  homelabMetrics: [{ id: 'activeAlerts', label: 'Active alerts' }],
  stateTargets: [{ id: 'host_offline', label: 'Host offline' }],
  checkModes: [{ id: 'consecutive_failures', label: 'Consecutive failures' }],
  notificationRoutes: [{ id: 'route-1', name: 'Discord Ops', type: 'DISCORD' }],
  hosts: [{ id: 'host-1', hostname: 'nas-01', hostIp: '10.0.0.10' }],
  services: [{ id: 'service-1', name: 'Plex' }],
  checks: [{ id: 'check-1', name: 'Plex HTTP', hostId: 'host-1', serviceId: 'service-1' }],
};

const incidentsResponse = [
  {
    id: 'incident-1',
    ruleId: 'rule-1',
    ruleName: 'Host offline',
    fingerprint: 'rule-1:host-1',
    state: 'FIRING',
    severity: 'ERROR',
    message: 'Host nas-01 is offline',
    labels: { team: 'ops' },
    values: { host: 'nas-01' },
    startedAt: '2026-03-14T10:00:00.000Z',
    lastMatchedAt: '2026-03-14T10:05:00.000Z',
    lastEvaluatedAt: '2026-03-14T10:05:00.000Z',
    resolvedAt: null,
    acknowledgedAt: null,
    host: { id: 'host-1', name: 'nas-01' },
    service: null,
    check: null,
  },
];

const rulesResponse = [
  {
    id: 'rule-1',
    name: 'Host offline',
    description: 'Alert when a host heartbeat goes stale.',
    enabled: true,
    specVersion: 1,
    type: 'RULE_ENGINE',
    createdAt: '2026-03-14T08:00:00.000Z',
    updatedAt: '2026-03-14T09:00:00.000Z',
    spec: {
      scope: {
        entity: 'host',
        hostIds: ['host-1'],
        serviceIds: [],
        checkIds: [],
        tags: ['storage'],
      },
      conditions: {
        match: 'ALL',
        items: [{ kind: 'state', target: 'host_offline', staleMinutes: 5 }],
      },
      evaluation: {
        pendingMinutes: 5,
        recoveryMinutes: 2,
        noDataBehavior: 'KEEP_STATE',
      },
      severity: 'ERROR',
      labels: {
        team: 'ops',
      },
      delivery: {
        routeIds: ['route-1'],
        repeatMinutes: 60,
        sendResolved: true,
      },
    },
  },
];

/**
 * Renders the render alerts page view.
 */
function renderAlertsPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AlertsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AlertsPage', () => {
  it('loads incidents and rules, then lets an operator load a stored rule into the builder', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/alerts/incidents' && (!init || !init.method)) {
        return { incidents: incidentsResponse };
      }
      if (path === '/api/alerts/rules' && (!init || !init.method)) {
        return { rules: rulesResponse };
      }
      if (path === '/api/alerts/catalog' && (!init || !init.method)) {
        return catalogResponse;
      }
      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    renderAlertsPage();

    await screen.findByText('Host nas-01 is offline');
    expect(screen.getByText('Alert when a host heartbeat goes stale.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit in builder' }));

    expect(screen.getByLabelText('Rule name')).toHaveValue('Host offline');
    expect(screen.getByDisplayValue('storage')).toBeInTheDocument();
    expect(screen.getByDisplayValue('team=ops')).toBeInTheDocument();
  });

  it('drafts with AI, previews the rule, and saves it enabled', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/alerts/incidents' && (!init || !init.method)) {
        return { incidents: incidentsResponse };
      }
      if (path === '/api/alerts/rules' && (!init || !init.method)) {
        return { rules: rulesResponse };
      }
      if (path === '/api/alerts/catalog' && (!init || !init.method)) {
        return catalogResponse;
      }
      if (path === '/api/alerts/ai/parse' && init?.method === 'POST') {
        return {
          aiEnabled: true,
          generatedByAi: true,
          warnings: ['Review the generated repeat interval before saving.'],
          rationale: 'The rule targets host CPU averages over a sustained window.',
          confidence: 87,
          draft: {
            name: 'Sustained host CPU',
            description: 'Alert when average CPU exceeds 90% for 15 minutes.',
            enabled: false,
            spec: {
              scope: {
                entity: 'host',
                hostIds: [],
                serviceIds: [],
                checkIds: [],
                tags: [],
              },
              conditions: {
                match: 'ALL',
                items: [
                  {
                    kind: 'host_metric',
                    metric: 'cpuPct',
                    comparator: 'GTE',
                    threshold: 90,
                    reducer: 'avg',
                    windowMinutes: 15,
                  },
                ],
              },
              evaluation: {
                pendingMinutes: 5,
                recoveryMinutes: 2,
                noDataBehavior: 'KEEP_STATE',
              },
              severity: 'ERROR',
              labels: {
                team: 'ops',
              },
              delivery: {
                routeIds: ['route-1'],
                repeatMinutes: 60,
                sendResolved: true,
              },
            },
          },
        };
      }
      if (path === '/api/alerts/preview' && init?.method === 'POST') {
        return {
          evaluatedAt: '2026-03-14T10:06:00.000Z',
          summary: {
            candidateCount: 2,
            matchedCount: 1,
            pendingCount: 0,
            firingCount: 1,
          },
          incidents: [
            {
              fingerprint: 'draft:host-1',
              state: 'FIRING',
              message: 'Host nas-01 CPU average is 92%',
              severity: 'ERROR',
              values: {
                condition_1: 92,
              },
              host: {
                id: 'host-1',
                name: 'nas-01',
              },
              service: null,
              check: null,
            },
          ],
        };
      }
      if (path === '/api/alerts/rules' && init?.method === 'POST') {
        return { id: 'rule-new' };
      }
      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    renderAlertsPage();

    await screen.findByText('Alert when a host heartbeat goes stale.');
    fireEvent.change(
      screen.getByPlaceholderText(
        'Alert when any host disk stays above 85% for 30 minutes and repeat hourly.',
      ),
      {
        target: { value: 'Alert when average host CPU is above 90% for 15 minutes.' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));

    await screen.findByText(/AI drafted a rule/);
    expect(
      screen.getByText('Review the generated repeat interval before saving.'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('Sustained host CPU')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Preview rule' }));

    await screen.findByText('Host nas-01 CPU average is 92%');
    expect(screen.getByText('condition_1=92')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create and enable' }));

    await waitFor(() => {
      const createCall = vi
        .mocked(apiFetch)
        .mock.calls.find((call) => call[0] === '/api/alerts/rules' && call[1]?.method === 'POST');
      expect(createCall).toBeTruthy();
      expect(createCall?.[1]?.body).toContain('"confirm":true');
      expect(createCall?.[1]?.body).toContain('"enabled":true');
      expect(createCall?.[1]?.body).toContain('"name":"Sustained host CPU"');
    });
  });

  it('acknowledges and silences incidents from the incident list', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/alerts/incidents' && (!init || !init.method)) {
        return { incidents: incidentsResponse };
      }
      if (path === '/api/alerts/rules' && (!init || !init.method)) {
        return { rules: rulesResponse };
      }
      if (path === '/api/alerts/catalog' && (!init || !init.method)) {
        return catalogResponse;
      }
      if (path === '/api/alerts/incidents/incident-1/ack' && init?.method === 'POST') {
        return { ok: true };
      }
      if (path === '/api/silences' && init?.method === 'POST') {
        return { id: 'silence-1' };
      }
      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    renderAlertsPage();

    await screen.findByText('Host nas-01 is offline');
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Silence 1h' }));

    await waitFor(() => {
      const ackCall = vi
        .mocked(apiFetch)
        .mock.calls.find((call) => call[0] === '/api/alerts/incidents/incident-1/ack');
      const silenceCall = vi
        .mocked(apiFetch)
        .mock.calls.find((call) => call[0] === '/api/silences' && call[1]?.method === 'POST');

      expect(ackCall?.[1]?.body).toContain('"confirm":true');
      expect(silenceCall?.[1]?.body).toContain('"targetType":"ALERT_EVENT"');
      expect(silenceCall?.[1]?.body).toContain('"targetId":"incident-1"');
    });
  });
});
