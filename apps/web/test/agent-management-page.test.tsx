/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the agent management page test UI behavior.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentManagementPage } from '@/pages/agent-management-page';
import { apiFetch } from '@/lib/api';
import type { AgentInstallRequest, AgentRecoveryClaim, AgentSummary } from '@/types/api';

const useAuthMock = vi.fn();

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

/**
 * Builds recovery claim.
 */
function buildRecoveryClaim(overrides: Partial<AgentRecoveryClaim> = {}): AgentRecoveryClaim {
  return {
    id: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
    recoveryKeyAlg: 'ED25519',
    recoveryKeyFingerprint: 'ed25519:test-fingerprint',
    hostname: 'host-alpha',
    primaryIp: '192.168.1.44',
    displayName: 'rack-agent-1',
    endpoint: 'http://192.168.1.44:9001',
    mcpEndpoint: 'http://192.168.1.44:8081',
    agentVersion: 'v0.3.0',
    tags: ['edge', 'rack-1'],
    status: 'PENDING_APPROVAL',
    denialReason: null,
    firstSeenAt: '2026-03-12T12:00:00.000Z',
    lastSeenAt: '2026-03-12T12:05:00.000Z',
    approvedAt: null,
    deniedAt: null,
    completedAt: null,
    createdAt: '2026-03-12T12:00:00.000Z',
    updatedAt: '2026-03-12T12:05:00.000Z',
    agent: null,
    approvedBy: null,
    deniedBy: null,
    ...overrides,
  };
}

/**
 * Builds connected agent.
 */
function buildAgentSummary(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'f3f7f2e4-1b39-4b1f-98c6-6e0d8e6dc1f5',
    status: 'ONLINE',
    hostId: '7f6e4f53-2e1f-4c9f-b2b6-0e0f6e5eac42',
    revokedAt: null,
    displayName: 'rack-agent-1',
    lastSeenAt: '2026-03-12T12:05:00.000Z',
    host: {
      id: '7f6e4f53-2e1f-4c9f-b2b6-0e0f6e5eac42',
      hostname: 'host-alpha',
      tags: ['edge', 'rack-1'],
    },
    ...overrides,
  };
}

/**
 * Builds install request.
 */
function buildAgentInstallRequest(
  overrides: Partial<AgentInstallRequest> = {},
): AgentInstallRequest {
  return {
    id: 'request-install-1',
    action: 'INSTALL',
    status: 'SUCCEEDED',
    requestedByUserId: 'admin-user-1',
    approvedByUserId: 'admin-user-1',
    deniedByUserId: null,
    targetHostId: '7f6e4f53-2e1f-4c9f-b2b6-0e0f6e5eac42',
    targetHost: '192.168.1.44',
    targetPort: 22,
    targetUsername: 'root',
    authMode: 'KEY',
    binaryVersion: 'v0.3.0',
    binaryUrlResolved: null,
    controlPlaneUrl: 'http://localhost:3000',
    mcpBind: '0.0.0.0',
    mcpPort: 8081,
    mcpAdvertiseUrl: 'http://192.168.1.44:8081',
    allowedOrigins: 'http://localhost:5173',
    allowInsecureDev: true,
    replaceExisting: true,
    installPath: '/usr/local/bin/labagent',
    serviceName: 'labagent',
    rollbackOfRequestId: null,
    resultCode: null,
    resultSummary: null,
    errorMessageSanitized: null,
    agentIdLinked: 'f3f7f2e4-1b39-4b1f-98c6-6e0d8e6dc1f5',
    approvedAt: '2026-03-12T12:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    deniedAt: null,
    createdAt: '2026-03-12T12:00:00.000Z',
    updatedAt: '2026-03-12T12:00:00.000Z',
    logs: [],
    ...overrides,
  };
}

type AgentManagementMockOptions = {
  initialClaim?: AgentRecoveryClaim;
  agents?: AgentSummary[];
  installRequests?: AgentInstallRequest[];
  uninstallResult?: AgentInstallRequest | Error;
};

/**
 * Implements mock agent management requests.
 */
function mockAgentManagementRequests(options: AgentManagementMockOptions = {}) {
  let currentClaim = options.initialClaim ?? buildRecoveryClaim();
  let claims = [currentClaim];
  let agents = options.agents ?? [];
  let installRequests = options.installRequests ?? [];
  const installRequestDetails = new Map(
    installRequests.map((request) => [request.id, request] satisfies [string, AgentInstallRequest]),
  );

  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/agents' && (!init || !init.method)) {
      return agents;
    }
    if (path === '/api/hosts' && (!init || !init.method)) {
      return [];
    }
    if (path === '/api/enrollment-tokens' && (!init || !init.method)) {
      return [];
    }
    if (path === '/api/agent-installs/binaries' && (!init || !init.method)) {
      return {
        enabled: true,
        source: 'CONTAINER_STORE',
        storeRootConfigured: true,
        defaultVersion: 'v0.3.0',
        binaries: [
          {
            version: 'v0.3.0',
            platform: 'linux-amd64',
            available: true,
          },
        ],
      };
    }
    if (path === '/api/agent-installs/requests' && (!init || !init.method)) {
      return {
        requests: installRequests,
      };
    }
    if (path.startsWith('/api/agent-installs/requests/') && (!init || !init.method)) {
      const requestId = path.split('/').at(-1) ?? '';
      const request = installRequestDetails.get(requestId);
      if (!request) {
        throw new Error(`Unexpected install request detail fetch: ${path}`);
      }
      return request;
    }
    if (path.startsWith('/api/agent-installs/agents/') && path.endsWith('/uninstall')) {
      if (options.uninstallResult instanceof Error) {
        throw options.uninstallResult;
      }

      const createdRequest =
        options.uninstallResult ??
        buildAgentInstallRequest({
          id: 'rollback-request-id',
          action: 'ROLLBACK',
          status: 'APPROVED_AWAITING_EXECUTION',
          rollbackOfRequestId: 'request-install-1',
          updatedAt: '2026-03-12T12:06:00.000Z',
          createdAt: '2026-03-12T12:06:00.000Z',
        });

      installRequests = [
        createdRequest,
        ...installRequests.filter((request) => request.id !== createdRequest.id),
      ];
      installRequestDetails.set(createdRequest.id, createdRequest);
      agents = agents.map((agent) =>
        agent.id === createdRequest.agentIdLinked ? { ...agent } : agent,
      );
      return createdRequest;
    }
    if (path === '/api/agent-recovery/claims' && (!init || !init.method)) {
      return {
        claims,
      };
    }
    if (path === `/api/agent-recovery/claims/${currentClaim.id}` && (!init || !init.method)) {
      return currentClaim;
    }
    if (
      path === `/api/agent-recovery/claims/${currentClaim.id}/approve` &&
      init?.method === 'POST'
    ) {
      currentClaim = {
        ...currentClaim,
        status: 'APPROVED_PENDING_AGENT',
        approvedAt: '2026-03-12T12:06:00.000Z',
        updatedAt: '2026-03-12T12:06:00.000Z',
        agent: {
          id: 'd8ef4d73-c886-43cb-a6af-3eeb587f66af',
          hostId: '8ca6c1ed-2b29-4df1-b4b5-e62a0b3f1c91',
          status: 'OFFLINE',
          revokedAt: null,
        },
        approvedBy: {
          id: '9f2a0f3a-1df8-4464-9b67-27be1a8a7312',
          email: 'admin@local',
          displayName: 'Admin',
        },
      };
      claims = [currentClaim];
      return currentClaim;
    }
    if (path === `/api/agent-recovery/claims/${currentClaim.id}/deny` && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as { reason?: string };
      currentClaim = {
        ...currentClaim,
        status: 'DENIED',
        denialReason: body.reason?.trim() || null,
        deniedAt: '2026-03-12T12:06:00.000Z',
        updatedAt: '2026-03-12T12:06:00.000Z',
        approvedAt: null,
        approvedBy: null,
        agent: null,
        deniedBy: {
          id: '9f2a0f3a-1df8-4464-9b67-27be1a8a7312',
          email: 'admin@local',
          displayName: 'Admin',
        },
      };
      claims = [currentClaim];
      return currentClaim;
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
        <AgentManagementPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  useAuthMock.mockReset();
});

describe('AgentManagementPage orphan recovery claims', () => {
  it('approves a pending recovery claim for the signed-in admin account', async () => {
    useAuthMock.mockReturnValue({
      user: {
        id: 'admin-user-1',
        displayName: 'Admin',
      },
    });
    mockAgentManagementRequests();

    renderPage();

    expect(await screen.findByText('Orphan Recovery Claims')).toBeInTheDocument();
    expect((await screen.findAllByText('rack-agent-1')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Recovery Key Fingerprint')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve Claim' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/agent-recovery/claims/4f2026f5-58f6-4ef7-a53e-278fddf17de9/approve',
        {
          method: 'POST',
          body: JSON.stringify({ confirm: true }),
        },
      );
    });

    expect(
      await screen.findByText('Recovery claim for rack-agent-1 approved.'),
    ).toBeInTheDocument();
    expect((await screen.findAllByText('APPROVED PENDING AGENT')).length).toBeGreaterThan(0);
  });

  it('denies a pending recovery claim with an admin-supplied reason', async () => {
    useAuthMock.mockReturnValue({
      user: {
        id: 'admin-user-1',
        displayName: 'Admin',
      },
    });
    mockAgentManagementRequests();

    renderPage();

    expect((await screen.findAllByText('rack-agent-1')).length).toBeGreaterThan(0);

    fireEvent.change(await screen.findByLabelText('Denial Reason'), {
      target: { value: 'Host already has another active agent.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Deny Claim' }));

    await waitFor(() => {
      const denyCall = vi
        .mocked(apiFetch)
        .mock.calls.find(
          (call) =>
            call[0] === '/api/agent-recovery/claims/4f2026f5-58f6-4ef7-a53e-278fddf17de9/deny' &&
            call[1]?.method === 'POST',
        );
      expect(denyCall).toBeTruthy();
      expect(JSON.parse(String(denyCall?.[1]?.body ?? '{}'))).toEqual({
        confirm: true,
        reason: 'Host already has another active agent.',
      });
    });

    expect(await screen.findByText('Recovery claim for rack-agent-1 denied.')).toBeInTheDocument();
    expect(await screen.findByText('Recorded Denial Reason')).toBeInTheDocument();
    expect(
      (await screen.findAllByText('Host already has another active agent.')).length,
    ).toBeGreaterThan(0);
  });

  it('keeps recovery claim actions available to the signed-in admin account', async () => {
    useAuthMock.mockReturnValue({
      user: {
        id: 'admin-user-1',
        displayName: 'Admin',
      },
    });
    mockAgentManagementRequests();

    renderPage();

    expect((await screen.findAllByText('rack-agent-1')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Approve Claim' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Deny Claim' })).toBeDisabled();
  });
});

describe('AgentManagementPage connected agents uninstall flow', () => {
  it('queues an uninstall request and shows connected-agent feedback', async () => {
    useAuthMock.mockReturnValue({
      user: {
        id: 'admin-user-1',
        displayName: 'Admin',
      },
    });
    mockAgentManagementRequests({
      agents: [buildAgentSummary()],
      installRequests: [],
      uninstallResult: buildAgentInstallRequest({
        id: 'rollback-request-id',
        action: 'ROLLBACK',
        status: 'APPROVED_AWAITING_EXECUTION',
        rollbackOfRequestId: 'request-install-1',
        createdAt: '2026-03-12T12:06:00.000Z',
        updatedAt: '2026-03-12T12:06:00.000Z',
      }),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall Agent' }));

    await waitFor(() => {
      const uninstallCall = vi
        .mocked(apiFetch)
        .mock.calls.find(
          (call) =>
            call[0] ===
              '/api/agent-installs/agents/f3f7f2e4-1b39-4b1f-98c6-6e0d8e6dc1f5/uninstall' &&
            call[1]?.method === 'POST',
        );
      expect(uninstallCall).toBeTruthy();
      expect(JSON.parse(String(uninstallCall?.[1]?.body ?? '{}'))).toEqual({
        confirm: true,
      });
    });

    expect(
      await screen.findByText(
        'Uninstall request rollback-request-id created. Use Run in Install Queue to execute.',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Uninstall Queued' })).toBeDisabled();
    expect(await screen.findByText('Request: rollback-request-id')).toBeInTheDocument();
    expect(await screen.findByText('APPROVED AWAITING EXECUTION')).toBeInTheDocument();
  });

  it('opens a queued uninstall request in the install queue and scrolls to it', async () => {
    const scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    });

    useAuthMock.mockReturnValue({
      user: {
        id: 'admin-user-1',
        displayName: 'Admin',
      },
    });

    const unrelatedRequest = buildAgentInstallRequest({
      id: 'request-install-2',
      action: 'INSTALL',
      status: 'APPROVED_AWAITING_EXECUTION',
      agentIdLinked: null,
      targetHost: '192.168.1.45',
      createdAt: '2026-03-12T12:00:00.000Z',
      updatedAt: '2026-03-12T12:00:00.000Z',
    });
    const queuedUninstall = buildAgentInstallRequest({
      id: 'rollback-request-id',
      action: 'ROLLBACK',
      status: 'APPROVED_AWAITING_EXECUTION',
      rollbackOfRequestId: 'request-install-1',
      createdAt: '2026-03-12T12:06:00.000Z',
      updatedAt: '2026-03-12T12:06:00.000Z',
    });

    mockAgentManagementRequests({
      agents: [buildAgentSummary()],
      installRequests: [unrelatedRequest, queuedUninstall],
    });

    renderPage();

    expect(await screen.findByText('request-install-2')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'View in Queue' }));

    await waitFor(() => {
      expect(screen.getByText('rollback-request-id')).toBeInTheDocument();
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });
  });

  it('shows uninstall failures without leaving the agent row stuck', async () => {
    useAuthMock.mockReturnValue({
      user: {
        id: 'admin-user-1',
        displayName: 'Admin',
      },
    });
    mockAgentManagementRequests({
      agents: [buildAgentSummary()],
      installRequests: [],
      uninstallResult: new Error('No successful install request found for this agent'),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall Agent' }));

    expect(
      await screen.findByText(
        'Agent uninstall failed: No successful install request found for this agent',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Uninstall Agent' })).toBeEnabled();
  });
});
