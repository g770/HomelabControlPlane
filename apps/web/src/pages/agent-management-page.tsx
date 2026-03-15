/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the agent management page route view.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { PageSkeleton } from '@/components/page-skeleton';
import { apiFetch } from '@/lib/api';
import { apiBaseUrl } from '@/lib/utils';
import type {
  AgentRecoveryClaim,
  AgentRecoveryClaimApprovePayload,
  AgentRecoveryClaimDenyPayload,
  AgentRecoveryClaimListResponse,
  AgentSummary,
  AgentInstallBinaryManifestResponse,
  AgentInstallLaunchResponse,
  AgentInstallListResponse,
  AgentInstallRequest,
  AgentInstallRequestLog,
  EnrollmentToken,
  HostSummary,
} from '@/types/api';

/**
 * Implements default browser origin.
 */
export function defaultBrowserOrigin() {
  if (typeof window === 'undefined') {
    return 'http://localhost:5173';
  }
  return window.location.origin;
}

/**
 * Builds mcp advertise url.
 */
export function buildMcpAdvertiseUrl(targetHost: string, mcpPort: string) {
  const trimmedHost = targetHost.trim();
  if (!trimmedHost) {
    return '';
  }

  const parsedPort = Number(mcpPort);
  const safePort =
    Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
      ? String(Math.round(parsedPort))
      : '8081';
  return `http://${trimmedHost}:${safePort}`;
}

type LaunchBody = {
  confirm: true;
  authMode: 'KEY' | 'PASSWORD';
  sshPrivateKey?: string;
  sshPassword?: string;
  sudoPassword?: string;
};

type CreateAndRunPayload = {
  createPayload: Record<string, unknown>;
  launchBody: LaunchBody;
};

type AgentActionFeedback = {
  tone: 'success' | 'error';
  message: string;
};

/**
 * Implements recovery claim label.
 */
function recoveryClaimLabel(claim: Pick<AgentRecoveryClaim, 'displayName' | 'hostname' | 'id'>) {
  return claim.displayName?.trim() || claim.hostname || claim.id;
}

/**
 * Implements format status label.
 */
function formatStatusLabel(status: string) {
  return status.replace(/_/g, ' ');
}

/**
 * Implements format timestamp.
 */
function formatTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : '-';
}

/**
 * Renders the agent management page view.
 */
export function AgentManagementPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const installHostIdParam = searchParams.get('installHostId');
  const installHostParam = searchParams.get('installHost');
  const installUsernameParam = searchParams.get('installUsername');

  const canViewRecoveryClaims = true;
  const canActOnRecoveryClaims = true;
  const canManageInstallRequests = true;
  const canManageEnrollmentTokens = true;
  const canRevokeAgents = true;
  const canDeleteRevokedAgents = true;

  const initialControlPlaneUrl = apiBaseUrl.replace(/\/$/, '');
  const initialAllowedOrigins = defaultBrowserOrigin();
  const [installTargetMode, setInstallTargetMode] = useState<'existing' | 'manual'>(
    installHostIdParam ? 'existing' : 'manual',
  );
  const [installTargetHostId, setInstallTargetHostId] = useState(installHostIdParam ?? '');
  const [installTargetHost, setInstallTargetHost] = useState(installHostParam ?? '');
  const [sshUsername, setSshUsername] = useState(installUsernameParam ?? 'root');
  const [sshPort, setSshPort] = useState('22');
  const [sshAuthMode, setSshAuthMode] = useState<'KEY' | 'PASSWORD'>('KEY');
  const [sshPrivateKey, setSshPrivateKey] = useState('');
  const [sshPassword, setSshPassword] = useState('');
  const [sudoPassword, setSudoPassword] = useState('');
  const [installBinaryVersion, setInstallBinaryVersion] = useState('v0.2.0');
  const [installControlPlaneUrl, setInstallControlPlaneUrl] = useState(initialControlPlaneUrl);
  const [installMcpBind, setInstallMcpBind] = useState('0.0.0.0');
  const [installMcpPort, setInstallMcpPort] = useState('8081');
  const [installMcpAdvertiseUrl, setInstallMcpAdvertiseUrl] = useState(() =>
    buildMcpAdvertiseUrl(installHostParam ?? '', '8081'),
  );
  const [installMcpAdvertiseUrlCustomized, setInstallMcpAdvertiseUrlCustomized] = useState(false);
  const [installAllowedOrigins, setInstallAllowedOrigins] = useState(initialAllowedOrigins);
  const [installAllowInsecureDev, setInstallAllowInsecureDev] = useState(true);
  const [installReplaceExisting, setInstallReplaceExisting] = useState(true);
  const [installPath, setInstallPath] = useState('/usr/local/bin/labagent');
  const [installServiceName, setInstallServiceName] = useState('labagent');
  const [installFormError, setInstallFormError] = useState<string | null>(null);
  const [queueActionError, setQueueActionError] = useState<string | null>(null);
  const [selectedInstallRequestId, setSelectedInstallRequestId] = useState<string | null>(null);
  const [selectedRecoveryClaimId, setSelectedRecoveryClaimId] = useState<string | null>(null);
  const [recoveryDenyReason, setRecoveryDenyReason] = useState('');
  const [recoveryActionError, setRecoveryActionError] = useState<string | null>(null);
  const [recoveryActionStatus, setRecoveryActionStatus] = useState<string | null>(null);
  const [showRevokedAgents, setShowRevokedAgents] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [managementStatus, setManagementStatus] = useState<string | null>(null);
  const [agentActionFeedback, setAgentActionFeedback] = useState<AgentActionFeedback | null>(null);
  const [queuedUninstallRequests, setQueuedUninstallRequests] = useState<
    Record<string, AgentInstallRequest>
  >({});
  const installQueueCardRef = useRef<HTMLDivElement | null>(null);

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => apiFetch<AgentSummary[]>('/api/agents'),
  });
  const hostsQuery = useQuery({
    queryKey: ['hosts'],
    queryFn: () => apiFetch<HostSummary[]>('/api/hosts'),
  });
  const enrollmentTokensQuery = useQuery({
    queryKey: ['enrollment-tokens'],
    queryFn: () => apiFetch<EnrollmentToken[]>('/api/enrollment-tokens'),
  });
  const agentInstallManifestQuery = useQuery({
    queryKey: ['agent-install-binaries'],
    queryFn: () => apiFetch<AgentInstallBinaryManifestResponse>('/api/agent-installs/binaries'),
  });
  const agentInstallRequestsQuery = useQuery({
    queryKey: ['agent-install-requests'],
    queryFn: () => apiFetch<AgentInstallListResponse>('/api/agent-installs/requests'),
    refetchInterval: 3_000,
  });
  const selectedInstallRequestQuery = useQuery({
    queryKey: ['agent-install-request', selectedInstallRequestId],
    queryFn: () =>
      apiFetch<AgentInstallRequest>(`/api/agent-installs/requests/${selectedInstallRequestId}`),
    enabled: Boolean(selectedInstallRequestId),
    refetchInterval: 3_000,
  });
  const agentRecoveryClaimsQuery = useQuery({
    queryKey: ['agent-recovery-claims'],
    queryFn: () => apiFetch<AgentRecoveryClaimListResponse>('/api/agent-recovery/claims'),
    enabled: canViewRecoveryClaims,
    refetchInterval: 5_000,
  });
  const selectedRecoveryClaimQuery = useQuery({
    queryKey: ['agent-recovery-claim', selectedRecoveryClaimId],
    queryFn: () =>
      apiFetch<AgentRecoveryClaim>(`/api/agent-recovery/claims/${selectedRecoveryClaimId}`),
    enabled: canViewRecoveryClaims && Boolean(selectedRecoveryClaimId),
    refetchInterval: 5_000,
  });

  useEffect(() => {
    const manifest = agentInstallManifestQuery.data;
    if (!manifest) {
      return;
    }

    const fallbackVersion = manifest.defaultVersion || 'v0.2.0';
    const availableVersions = Array.from(
      new Set(manifest.binaries.filter((entry) => entry.available).map((entry) => entry.version)),
    );
    if (availableVersions.length === 0) {
      setInstallBinaryVersion(fallbackVersion);
      return;
    }

    const nextVersion = availableVersions[0] ?? fallbackVersion;
    setInstallBinaryVersion((current) =>
      availableVersions.includes(current) ? current : nextVersion,
    );
  }, [agentInstallManifestQuery.data]);

  const hostOptions = (hostsQuery.data ?? [])
    .map((host) => {
      const id = host.id;
      const hostname = host.hostname || id;
      const hostIp = host.hostIp ?? '';
      return {
        id,
        hostname,
        hostIp,
        target: hostIp && hostIp !== '-' ? hostIp : hostname,
      };
    })
    .filter((host) => host.id.length > 0);
  const selectedHostOption = hostOptions.find((host) => host.id === installTargetHostId) ?? null;

  useEffect(() => {
    if (!installHostIdParam && !installHostParam) {
      return;
    }
    if (installHostIdParam) {
      setInstallTargetMode('existing');
      setInstallTargetHostId(installHostIdParam);
    } else {
      setInstallTargetMode('manual');
    }
    if (installHostParam) {
      setInstallTargetHost(installHostParam);
      setInstallMcpAdvertiseUrl(buildMcpAdvertiseUrl(installHostParam, installMcpPort));
      setInstallMcpAdvertiseUrlCustomized(false);
    }
    if (installUsernameParam) {
      setSshUsername(installUsernameParam);
    }
  }, [installHostIdParam, installHostParam, installMcpPort, installUsernameParam]);

  useEffect(() => {
    if (installTargetMode !== 'existing' || !selectedHostOption) {
      return;
    }
    setInstallTargetHost(selectedHostOption.target);
  }, [installTargetMode, selectedHostOption]);

  useEffect(() => {
    if (installMcpAdvertiseUrlCustomized) {
      return;
    }
    const targetHost =
      installTargetMode === 'existing' ? (selectedHostOption?.target ?? '') : installTargetHost;
    const suggested = buildMcpAdvertiseUrl(targetHost, installMcpPort);
    if (!suggested) {
      return;
    }
    setInstallMcpAdvertiseUrl((current) => (current === suggested ? current : suggested));
  }, [
    installMcpAdvertiseUrlCustomized,
    installMcpPort,
    installTargetHost,
    installTargetMode,
    selectedHostOption,
  ]);

  const installRequests = useMemo(
    () => agentInstallRequestsQuery.data?.requests ?? [],
    [agentInstallRequestsQuery.data],
  );
  const recoveryClaims = useMemo(
    () => agentRecoveryClaimsQuery.data?.claims ?? [],
    [agentRecoveryClaimsQuery.data],
  );
  const queuedUninstallRequestIds = useMemo(
    () => new Set(Object.values(queuedUninstallRequests).map((request) => request.id)),
    [queuedUninstallRequests],
  );

  useEffect(() => {
    setQueuedUninstallRequests((current) => {
      let changed = false;
      const next = { ...current };

      for (const [agentId, request] of Object.entries(current)) {
        if (!installRequests.some((entry) => entry.id === request.id)) {
          continue;
        }
        delete next[agentId];
        changed = true;
      }

      return changed ? next : current;
    });
  }, [installRequests]);

  useEffect(() => {
    if (installRequests.length === 0) {
      if (selectedInstallRequestId && !queuedUninstallRequestIds.has(selectedInstallRequestId)) {
        setSelectedInstallRequestId(null);
      }
      return;
    }

    if (
      !selectedInstallRequestId ||
      (!installRequests.some((request) => request.id === selectedInstallRequestId) &&
        !queuedUninstallRequestIds.has(selectedInstallRequestId))
    ) {
      setSelectedInstallRequestId(installRequests[0]?.id ?? null);
    }
  }, [installRequests, queuedUninstallRequestIds, selectedInstallRequestId]);

  useEffect(() => {
    if (!canViewRecoveryClaims) {
      if (selectedRecoveryClaimId) {
        setSelectedRecoveryClaimId(null);
      }
      return;
    }

    if (recoveryClaims.length === 0) {
      if (selectedRecoveryClaimId) {
        setSelectedRecoveryClaimId(null);
      }
      return;
    }

    if (
      !selectedRecoveryClaimId ||
      !recoveryClaims.some((claim) => claim.id === selectedRecoveryClaimId)
    ) {
      setSelectedRecoveryClaimId(recoveryClaims[0]?.id ?? null);
    }
  }, [canViewRecoveryClaims, recoveryClaims, selectedRecoveryClaimId]);

  useEffect(() => {
    setRecoveryDenyReason('');
    setRecoveryActionError(null);
    setRecoveryActionStatus(null);
  }, [selectedRecoveryClaimId]);

  const selectedInstallRequest = selectedInstallRequestQuery.data ?? null;
  const selectedRecoveryClaimSummary =
    recoveryClaims.find((claim) => claim.id === selectedRecoveryClaimId) ?? null;
  const selectedRecoveryClaim = selectedRecoveryClaimQuery.data ?? selectedRecoveryClaimSummary;
  const installFeatureEnabled = Boolean(agentInstallManifestQuery.data?.enabled);
  const installBinaryVersions = Array.from(
    new Set(
      (agentInstallManifestQuery.data?.binaries ?? [])
        .filter((entry) => entry.available)
        .map((entry) => entry.version),
    ),
  );
  const hasAvailableInstallBinary = installBinaryVersions.length > 0;
  const installManifestDefaultVersion = agentInstallManifestQuery.data?.defaultVersion ?? 'v0.2.0';
  const controlPlaneUrl = apiBaseUrl.replace(/\/$/, '');
  const browserOrigin = defaultBrowserOrigin();

  const createAndRunInstallMutation = useMutation({
    mutationFn: async (payload: CreateAndRunPayload) => {
      const request = await apiFetch<AgentInstallRequest>('/api/agent-installs/requests', {
        method: 'POST',
        body: JSON.stringify(payload.createPayload),
      });

      try {
        const launch = await apiFetch<AgentInstallLaunchResponse>(
          `/api/agent-installs/requests/${request.id}/launch`,
          {
            method: 'POST',
            body: JSON.stringify(payload.launchBody),
          },
        );
        return {
          request,
          launch,
          launchError: null as string | null,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to launch install request.';
        return {
          request,
          launch: null,
          launchError: message,
        };
      }
    },
    onSuccess: async (result) => {
      setSelectedInstallRequestId(result.request.id);
      setQueueActionError(null);
      if (result.launchError) {
        setInstallFormError(`Install request created but launch failed: ${result.launchError}`);
        setManagementStatus(
          `Install request ${result.request.id} created. Launch failed; retry from Install Queue.`,
        );
      } else if (result.launch?.alreadyLaunched) {
        const currentStatus = result.launch.currentStatus
          ? String(result.launch.currentStatus).toLowerCase()
          : 'already launched';
        setInstallFormError(null);
        setManagementStatus(`Request ${result.request.id} is ${currentStatus}.`);
      } else {
        setInstallFormError(null);
        setManagementStatus(`Request ${result.request.id} queued for execution.`);
      }
      await queryClient.invalidateQueries({ queryKey: ['agent-install-requests'] });
      await queryClient.invalidateQueries({
        queryKey: ['agent-install-request', result.request.id],
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to create install request.';
      setInstallFormError(message);
    },
  });

  const launchAgentInstallRequestMutation = useMutation({
    mutationFn: (payload: { requestId: string; body: LaunchBody }) =>
      apiFetch<AgentInstallLaunchResponse>(
        `/api/agent-installs/requests/${payload.requestId}/launch`,
        {
          method: 'POST',
          body: JSON.stringify(payload.body),
        },
      ),
    onSuccess: async (result) => {
      setQueueActionError(null);
      if (result.alreadyLaunched) {
        const currentStatus = result.currentStatus
          ? String(result.currentStatus).toLowerCase()
          : 'already launched';
        setManagementStatus(`Request ${result.requestId} is ${currentStatus}.`);
      } else {
        setManagementStatus(`Request ${result.requestId} queued for execution.`);
      }
      await queryClient.invalidateQueries({ queryKey: ['agent-install-requests'] });
      await queryClient.invalidateQueries({
        queryKey: ['agent-install-request', result.requestId],
      });
    },
    onError: async (error, variables) => {
      const defaultMessage =
        error instanceof Error ? error.message : 'Failed to launch install request.';
      let message = defaultMessage;
      try {
        const request = await apiFetch<AgentInstallRequest>(
          `/api/agent-installs/requests/${variables.requestId}`,
        );
        if (request.status === 'RUNNING') {
          message = `Request ${variables.requestId} is already running.`;
        } else if (request.status === 'SUCCEEDED') {
          message = `Request ${variables.requestId} already completed successfully.`;
        }
      } catch {
        // Keep default message when status refresh fails.
      }

      setQueueActionError(message);
      setManagementStatus(message);
      await queryClient.invalidateQueries({ queryKey: ['agent-install-requests'] });
      await queryClient.invalidateQueries({
        queryKey: ['agent-install-request', variables.requestId],
      });
    },
  });

  const cancelAgentInstallRequestMutation = useMutation({
    mutationFn: (requestId: string) =>
      apiFetch<AgentInstallRequest>(`/api/agent-installs/requests/${requestId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: async (request) => {
      setManagementStatus(`Request ${request.id} canceled.`);
      await queryClient.invalidateQueries({ queryKey: ['agent-install-requests'] });
      await queryClient.invalidateQueries({ queryKey: ['agent-install-request', request.id] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to cancel install request.';
      setManagementStatus(message);
    },
  });

  const deleteAgentInstallRequestMutation = useMutation({
    mutationFn: (requestId: string) =>
      apiFetch<{ ok: boolean; deleted: boolean; requestId: string }>(
        `/api/agent-installs/requests/${requestId}`,
        {
          method: 'DELETE',
          body: JSON.stringify({ confirm: true }),
        },
      ),
    onSuccess: async (result) => {
      if (selectedInstallRequestId === result.requestId) {
        setSelectedInstallRequestId(null);
      }
      setManagementStatus(`Request ${result.requestId} deleted.`);
      await queryClient.invalidateQueries({ queryKey: ['agent-install-requests'] });
      await queryClient.invalidateQueries({
        queryKey: ['agent-install-request', result.requestId],
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to delete install request.';
      setManagementStatus(message);
    },
  });

  const createEnrollmentMutation = useMutation({
    mutationFn: (expiresHours: number) =>
      apiFetch<{ token?: string }>('/api/enrollment-tokens', {
        method: 'POST',
        body: JSON.stringify({ expiresHours }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['enrollment-tokens'] });
    },
  });

  const revokeEnrollmentTokenMutation = useMutation({
    mutationFn: (tokenId: string) =>
      apiFetch<{ ok: boolean }>(`/api/enrollment-tokens/${tokenId}/revoke`, {
        method: 'POST',
      }),
    onSuccess: async (_result, tokenId) => {
      setManagementStatus(`Enrollment token ${tokenId} revoked.`);
      await queryClient.invalidateQueries({ queryKey: ['enrollment-tokens'] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to revoke enrollment token.';
      setManagementStatus(`Enrollment token revoke failed: ${message}`);
    },
  });

  const revokeAgentMutation = useMutation({
    mutationFn: (agentId: string) =>
      apiFetch<{ ok: boolean; alreadyRevoked?: boolean }>(`/api/agents/${agentId}/revoke`, {
        method: 'POST',
      }),
    onMutate: () => {
      setAgentActionFeedback(null);
    },
    onSuccess: async (result, agentId) => {
      setAgentActionFeedback({
        tone: 'success',
        message: result.alreadyRevoked
          ? `Agent ${agentId} is already revoked.`
          : `Agent ${agentId} revoked.`,
      });
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to revoke agent token.';
      setAgentActionFeedback({
        tone: 'error',
        message: `Agent revoke failed: ${message}`,
      });
    },
  });

  const uninstallAgentMutation = useMutation({
    mutationFn: (agentId: string) =>
      apiFetch<AgentInstallRequest>(`/api/agent-installs/agents/${agentId}/uninstall`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      }),
    onMutate: () => {
      setAgentActionFeedback(null);
    },
    onSuccess: async (request, agentId) => {
      setQueuedUninstallRequests((current) => ({
        ...current,
        [agentId]: request,
      }));
      setAgentActionFeedback({
        tone: 'success',
        message: `Uninstall request ${request.id} created. Use Run in Install Queue to execute.`,
      });
      revealInstallQueueRequest(request.id);
      await queryClient.invalidateQueries({ queryKey: ['agent-install-requests'] });
      await queryClient.invalidateQueries({ queryKey: ['agent-install-request', request.id] });
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : 'Failed to create uninstall request.';
      setAgentActionFeedback({
        tone: 'error',
        message: `Agent uninstall failed: ${message}`,
      });
    },
  });

  const deleteRevokedAgentMutation = useMutation({
    mutationFn: (agentId: string) =>
      apiFetch<{ ok: boolean }>(`/api/agents/${agentId}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      }),
    onMutate: () => {
      setAgentActionFeedback(null);
    },
    onSuccess: async (_result, agentId) => {
      setAgentActionFeedback({
        tone: 'success',
        message: `Agent ${agentId} deleted.`,
      });
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to delete revoked agent.';
      setAgentActionFeedback({
        tone: 'error',
        message: `Agent delete failed: ${message}`,
      });
    },
  });

  const approveRecoveryClaimMutation = useMutation({
    mutationFn: (claimId: string) =>
      apiFetch<AgentRecoveryClaim>(`/api/agent-recovery/claims/${claimId}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          confirm: true,
        } satisfies AgentRecoveryClaimApprovePayload),
      }),
    onMutate: () => {
      setRecoveryActionError(null);
      setRecoveryActionStatus(null);
    },
    onSuccess: async (claim) => {
      setRecoveryActionStatus(`Recovery claim for ${recoveryClaimLabel(claim)} approved.`);
      setManagementStatus(`Recovery claim ${claim.id} approved.`);
      await queryClient.invalidateQueries({ queryKey: ['agent-recovery-claims'] });
      await queryClient.invalidateQueries({ queryKey: ['agent-recovery-claim', claim.id] });
      await queryClient.invalidateQueries({ queryKey: ['agent-recovery-summary'] });
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to approve recovery claim.';
      setRecoveryActionError(message);
      setManagementStatus(`Recovery claim approve failed: ${message}`);
    },
  });

  const denyRecoveryClaimMutation = useMutation({
    mutationFn: (payload: { claimId: string; body: AgentRecoveryClaimDenyPayload }) =>
      apiFetch<AgentRecoveryClaim>(`/api/agent-recovery/claims/${payload.claimId}/deny`, {
        method: 'POST',
        body: JSON.stringify(payload.body),
      }),
    onMutate: () => {
      setRecoveryActionError(null);
      setRecoveryActionStatus(null);
    },
    onSuccess: async (claim) => {
      setRecoveryActionStatus(`Recovery claim for ${recoveryClaimLabel(claim)} denied.`);
      setManagementStatus(`Recovery claim ${claim.id} denied.`);
      await queryClient.invalidateQueries({ queryKey: ['agent-recovery-claims'] });
      await queryClient.invalidateQueries({ queryKey: ['agent-recovery-claim', claim.id] });
      await queryClient.invalidateQueries({ queryKey: ['agent-recovery-summary'] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to deny recovery claim.';
      setRecoveryActionError(message);
      setManagementStatus(`Recovery claim deny failed: ${message}`);
    },
  });

  const createdEnrollmentToken = String(createEnrollmentMutation.data?.token ?? '');
  const revokingEnrollmentTokenId = revokeEnrollmentTokenMutation.isPending
    ? revokeEnrollmentTokenMutation.variables
    : null;
  const revokingAgentId = revokeAgentMutation.isPending ? revokeAgentMutation.variables : null;
  const uninstallingAgentId = uninstallAgentMutation.isPending
    ? uninstallAgentMutation.variables
    : null;
  const deletingAgentId = deleteRevokedAgentMutation.isPending
    ? deleteRevokedAgentMutation.variables
    : null;
  const cancelingInstallRequestId = cancelAgentInstallRequestMutation.isPending
    ? cancelAgentInstallRequestMutation.variables
    : null;
  const deletingInstallRequestId = deleteAgentInstallRequestMutation.isPending
    ? deleteAgentInstallRequestMutation.variables
    : null;
  const approvingRecoveryClaimId = approveRecoveryClaimMutation.isPending
    ? approveRecoveryClaimMutation.variables
    : null;
  const denyingRecoveryClaimId = denyRecoveryClaimMutation.isPending
    ? denyRecoveryClaimMutation.variables?.claimId
    : null;
  const allAgents = agentsQuery.data ?? [];
  const visibleAgents = showRevokedAgents
    ? allAgents
    : allAgents.filter((agent) => !agent.revokedAt);
  const revokedCount = allAgents.filter((agent) => Boolean(agent.revokedAt)).length;
  const activeUninstallRequestsByAgentId = useMemo(() => {
    const activeRequests = new Map<string, AgentInstallRequest>();

    for (const request of installRequests) {
      if (
        request.action !== 'ROLLBACK' ||
        !request.agentIdLinked ||
        (request.status !== 'PENDING_APPROVAL' &&
          request.status !== 'APPROVED_AWAITING_EXECUTION' &&
          request.status !== 'RUNNING')
      ) {
        continue;
      }
      if (!activeRequests.has(request.agentIdLinked)) {
        activeRequests.set(request.agentIdLinked, request);
      }
    }

    for (const [agentId, request] of Object.entries(queuedUninstallRequests)) {
      if (!activeRequests.has(agentId)) {
        activeRequests.set(agentId, request);
      }
    }

    return activeRequests;
  }, [installRequests, queuedUninstallRequests]);

  /**
   * Implements validate ssh profile.
   */
  const validateSshProfile = (expectedAuthMode?: 'KEY' | 'PASSWORD') => {
    if (expectedAuthMode && expectedAuthMode !== sshAuthMode) {
      return `Request expects ${expectedAuthMode} auth, but SSH Access is set to ${sshAuthMode}.`;
    }
    if (sshAuthMode === 'KEY' && sshPrivateKey.trim().length === 0) {
      return 'SSH private key is required when auth mode is SSH key.';
    }
    if (sshAuthMode === 'PASSWORD' && sshPassword.trim().length === 0) {
      return 'SSH password is required when auth mode is SSH password.';
    }
    return null;
  };

  /**
   * Builds launch body for the surrounding workflow.
   */
  const buildLaunchBody = (): LaunchBody => ({
    confirm: true,
    authMode: sshAuthMode,
    sshPrivateKey: sshAuthMode === 'KEY' ? sshPrivateKey.trim() : undefined,
    sshPassword: sshAuthMode === 'PASSWORD' ? sshPassword.trim() : undefined,
    sudoPassword: sudoPassword.trim().length > 0 ? sudoPassword : undefined,
  });

  /**
   * Implements apply install smart defaults.
   */
  const applyInstallSmartDefaults = () => {
    const targetHost =
      installTargetMode === 'existing'
        ? (selectedHostOption?.target ?? installTargetHost)
        : installTargetHost;
    const defaultVersion = installBinaryVersions.includes(installManifestDefaultVersion)
      ? installManifestDefaultVersion
      : (installBinaryVersions[0] ?? installManifestDefaultVersion);

    setSshPort('22');
    setSshUsername('root');
    setSshAuthMode('KEY');
    setInstallBinaryVersion(defaultVersion);
    setInstallControlPlaneUrl(controlPlaneUrl);
    setInstallMcpBind('0.0.0.0');
    setInstallMcpPort('8081');
    setInstallMcpAdvertiseUrl(buildMcpAdvertiseUrl(targetHost, '8081'));
    setInstallMcpAdvertiseUrlCustomized(false);
    setInstallAllowedOrigins(browserOrigin);
    setInstallAllowInsecureDev(true);
    setInstallReplaceExisting(true);
    setInstallPath('/usr/local/bin/labagent');
    setInstallServiceName('labagent');
  };

  /**
   * Implements copy value.
   */
  const copyValue = async (value: string, label: string) => {
    if (!value) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label} copied.`);
    } catch {
      setCopyStatus(`Failed to copy ${label.toLowerCase()}.`);
    }
  };

  /**
   * Reveals install queue request.
   */
  const revealInstallQueueRequest = (requestId: string) => {
    setSelectedInstallRequestId(requestId);

    const scrollToQueue = () => {
      if (typeof installQueueCardRef.current?.scrollIntoView !== 'function') {
        return;
      }
      installQueueCardRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(scrollToQueue);
      return;
    }

    scrollToQueue();
  };

  /**
   * Handles create and run install.
   */
  const handleCreateAndRunInstall = () => {
    setInstallFormError(null);
    setQueueActionError(null);
    if (!installFeatureEnabled) {
      setInstallFormError('Agent install feature is disabled on the API.');
      return;
    }
    if (!hasAvailableInstallBinary) {
      setInstallFormError('No control-plane agent binaries are available in the API container.');
      return;
    }

    const profileError = validateSshProfile();
    if (profileError) {
      setInstallFormError(profileError);
      return;
    }

    const targetHost =
      installTargetMode === 'existing'
        ? (selectedHostOption?.target ?? '')
        : installTargetHost.trim();
    if (!targetHost) {
      setInstallFormError('Target host is required.');
      return;
    }

    const targetPort = Number(sshPort);
    if (!Number.isFinite(targetPort) || targetPort < 1 || targetPort > 65535) {
      setInstallFormError('SSH port must be between 1 and 65535.');
      return;
    }

    const mcpPort = Number(installMcpPort);
    if (!Number.isFinite(mcpPort) || mcpPort < 1 || mcpPort > 65535) {
      setInstallFormError('MCP port must be between 1 and 65535.');
      return;
    }

    const advertiseUrl =
      installMcpAdvertiseUrl.trim().length > 0
        ? installMcpAdvertiseUrl.trim()
        : buildMcpAdvertiseUrl(targetHost, String(mcpPort));

    createAndRunInstallMutation.mutate({
      createPayload: {
        confirm: true,
        action: 'INSTALL',
        targetHostId:
          installTargetMode === 'existing' ? installTargetHostId || undefined : undefined,
        targetHost,
        targetPort: Math.round(targetPort),
        targetUsername: sshUsername.trim() || 'root',
        authMode: sshAuthMode,
        binaryVersion: installBinaryVersion.trim() || 'v0.2.0',
        controlPlaneUrl: installControlPlaneUrl.trim() || controlPlaneUrl,
        mcpBind: installMcpBind.trim() || '0.0.0.0',
        mcpPort: Math.round(mcpPort),
        mcpAdvertiseUrl: advertiseUrl,
        allowedOrigins: installAllowedOrigins.trim() || browserOrigin,
        allowInsecureDev: installAllowInsecureDev,
        replaceExisting: installReplaceExisting,
        installPath: installPath.trim() || '/usr/local/bin/labagent',
        serviceName: installServiceName.trim() || 'labagent',
      },
      launchBody: buildLaunchBody(),
    });
  };

  /**
   * Handles run queued request.
   */
  const handleRunQueuedRequest = (request: AgentInstallRequest) => {
    setQueueActionError(null);
    if (request.status !== 'APPROVED_AWAITING_EXECUTION') {
      setQueueActionError(`Request ${request.id} is not launchable in status ${request.status}.`);
      return;
    }

    const profileError = validateSshProfile(request.authMode);
    if (profileError) {
      setQueueActionError(profileError);
      return;
    }

    launchAgentInstallRequestMutation.mutate({
      requestId: request.id,
      body: buildLaunchBody(),
    });
  };

  if (
    agentsQuery.isLoading ||
    hostsQuery.isLoading ||
    enrollmentTokensQuery.isLoading ||
    agentInstallManifestQuery.isLoading ||
    agentInstallRequestsQuery.isLoading ||
    (canViewRecoveryClaims && agentRecoveryClaimsQuery.isLoading)
  ) {
    return <PageSkeleton />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Install Agent</CardTitle>
          <CardDescription>
            Create and immediately run install requests with a single SSH Access profile.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {agentInstallManifestQuery.isError && (
            <div className="text-xs text-rose-400">
              Could not load agent install feature status.
            </div>
          )}
          {!installFeatureEnabled && (
            <div className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
              Agent install feature is disabled on the API (`AGENT_INSTALL_ENABLED=false`).
            </div>
          )}
          {installFeatureEnabled && !hasAvailableInstallBinary && (
            <div className="rounded-md border border-dashed border-amber-500/50 p-3 text-xs text-amber-200">
              No bundled agent binaries were found in the control-plane store. Rebuild API image
              with binaries under `AGENT_BINARY_STORE_ROOT` (default:
              `/opt/homelab-agent-binaries`).
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Target Source</div>
              <Select
                value={installTargetMode}
                onChange={(event) => {
                  setInstallTargetMode(event.target.value as 'existing' | 'manual');
                  setInstallMcpAdvertiseUrlCustomized(false);
                }}
              >
                <option value="existing">Existing host</option>
                <option value="manual">Manual target</option>
              </Select>
            </div>

            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">
                {installTargetMode === 'existing' ? 'Host' : 'Target Host / IP'}
              </div>
              {installTargetMode === 'existing' ? (
                <Select
                  value={installTargetHostId}
                  onChange={(event) => {
                    const nextHostId = event.target.value;
                    setInstallTargetHostId(nextHostId);
                    const matched = hostOptions.find((host) => host.id === nextHostId);
                    if (matched) {
                      setInstallTargetHost(matched.target);
                      setInstallMcpAdvertiseUrlCustomized(false);
                    }
                  }}
                >
                  <option value="">Select host</option>
                  {hostOptions.map((host) => (
                    <option key={host.id} value={host.id}>
                      {host.hostname} ({host.target})
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  value={installTargetHost}
                  onChange={(event) => setInstallTargetHost(event.target.value)}
                  placeholder="192.168.1.50 or host.local"
                />
              )}
            </div>
          </div>

          <div className="rounded-md border border-border/60 p-3">
            <div className="mb-2 text-sm font-medium">SSH Access</div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">SSH Username</div>
                <Input
                  value={sshUsername}
                  onChange={(event) => setSshUsername(event.target.value)}
                  placeholder="root"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">SSH Port</div>
                <Input
                  value={sshPort}
                  onChange={(event) => setSshPort(event.target.value)}
                  placeholder="22"
                  inputMode="numeric"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Auth Mode</div>
                <Select
                  value={sshAuthMode}
                  onChange={(event) => setSshAuthMode(event.target.value as 'KEY' | 'PASSWORD')}
                >
                  <option value="KEY">SSH key login</option>
                  <option value="PASSWORD">SSH password login</option>
                </Select>
              </div>
              {sshAuthMode === 'KEY' ? (
                <div className="space-y-1 md:col-span-2">
                  <div className="text-xs font-medium text-muted-foreground">SSH Private Key</div>
                  <Textarea
                    value={sshPrivateKey}
                    onChange={(event) => setSshPrivateKey(event.target.value)}
                    rows={5}
                    placeholder="Paste private key (ephemeral, not stored)"
                  />
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">SSH Password</div>
                  <Input
                    type="password"
                    value={sshPassword}
                    onChange={(event) => setSshPassword(event.target.value)}
                    placeholder="SSH password (ephemeral)"
                  />
                </div>
              )}
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">
                  Optional Sudo Password
                </div>
                <Input
                  type="password"
                  value={sudoPassword}
                  onChange={(event) => setSudoPassword(event.target.value)}
                  placeholder="Only if sudo prompts for password"
                />
              </div>
            </div>
          </div>

          <details className="rounded-md border border-border/60 p-3">
            <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Advanced Settings
            </summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">
                  Agent Binary Version
                </div>
                <Select
                  value={installBinaryVersion}
                  onChange={(event) => setInstallBinaryVersion(event.target.value)}
                  disabled={!hasAvailableInstallBinary}
                >
                  {installBinaryVersions.length === 0 && (
                    <option value={installManifestDefaultVersion}>
                      {installManifestDefaultVersion} (unavailable)
                    </option>
                  )}
                  {installBinaryVersions.map((version) => (
                    <option key={version} value={version}>
                      {version}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Control Plane URL</div>
                <Input
                  value={installControlPlaneUrl}
                  onChange={(event) => setInstallControlPlaneUrl(event.target.value)}
                  placeholder="http://control-plane.local:4000"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">MCP Bind Address</div>
                <Input
                  value={installMcpBind}
                  onChange={(event) => setInstallMcpBind(event.target.value)}
                  placeholder="0.0.0.0"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">MCP Port</div>
                <Input
                  value={installMcpPort}
                  onChange={(event) => setInstallMcpPort(event.target.value)}
                  placeholder="8081"
                  inputMode="numeric"
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <div className="text-xs font-medium text-muted-foreground">MCP Advertise URL</div>
                <Input
                  value={installMcpAdvertiseUrl}
                  onChange={(event) => {
                    setInstallMcpAdvertiseUrl(event.target.value);
                    setInstallMcpAdvertiseUrlCustomized(true);
                  }}
                  placeholder="http://192.168.1.50:8081"
                />
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span>URL the API should call to reach the agent MCP endpoint.</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const target =
                        installTargetMode === 'existing'
                          ? (selectedHostOption?.target ?? installTargetHost)
                          : installTargetHost;
                      setInstallMcpAdvertiseUrl(buildMcpAdvertiseUrl(target, installMcpPort));
                      setInstallMcpAdvertiseUrlCustomized(false);
                    }}
                  >
                    Use Suggested URL
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">
                  Allowed Browser Origins
                </div>
                <Input
                  value={installAllowedOrigins}
                  onChange={(event) => setInstallAllowedOrigins(event.target.value)}
                  placeholder={browserOrigin}
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Install Path</div>
                <Input
                  value={installPath}
                  onChange={(event) => setInstallPath(event.target.value)}
                  placeholder="/usr/local/bin/labagent"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Service Name</div>
                <Input
                  value={installServiceName}
                  onChange={(event) => setInstallServiceName(event.target.value)}
                  placeholder="labagent"
                />
              </div>
              <div className="space-y-1">
                <label className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs">
                  <input
                    type="checkbox"
                    checked={installReplaceExisting}
                    onChange={(event) => setInstallReplaceExisting(event.target.checked)}
                  />
                  Replace existing install before enroll
                </label>
              </div>
              <div className="space-y-1">
                <label className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs">
                  <input
                    type="checkbox"
                    checked={installAllowInsecureDev}
                    onChange={(event) => setInstallAllowInsecureDev(event.target.checked)}
                  />
                  Allow insecure dev bind
                </label>
              </div>
            </div>
          </details>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                !canManageInstallRequests ||
                createAndRunInstallMutation.isPending ||
                !installFeatureEnabled ||
                !hasAvailableInstallBinary
              }
              onClick={handleCreateAndRunInstall}
            >
              {createAndRunInstallMutation.isPending
                ? 'Creating and Running...'
                : 'Create and Run Install'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={createAndRunInstallMutation.isPending}
              onClick={applyInstallSmartDefaults}
            >
              Use Smart Defaults
            </Button>
          </div>

          {installFormError && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">
              {installFormError}
            </div>
          )}
        </CardContent>
      </Card>

      <div ref={installQueueCardRef}>
        <Card>
          <CardHeader>
            <CardTitle>Install Queue &amp; Logs</CardTitle>
            <CardDescription>
              Run queued requests with the SSH Access profile above. No secondary credential prompt
              is used.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {queueActionError && (
              <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">
                {queueActionError}
              </div>
            )}
            <div className="grid gap-3 xl:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Install Queue
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void agentInstallRequestsQuery.refetch()}
                  >
                    Refresh
                  </Button>
                </div>
                {agentInstallRequestsQuery.isError && (
                  <div className="text-xs text-rose-400">Failed to load install requests.</div>
                )}
                {!agentInstallRequestsQuery.isError && installRequests.length === 0 && (
                  <div className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
                    No install requests yet.
                  </div>
                )}
                {installRequests.map((request) => (
                  <div
                    key={request.id}
                    className={`rounded-md border border-border/60 p-3 ${selectedInstallRequestId === request.id ? 'border-sky-400/60' : ''}`}
                    onClick={() => setSelectedInstallRequestId(request.id)}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-medium">
                          {request.action} · {request.targetHost}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {request.status} · {new Date(request.createdAt).toLocaleString()}
                        </div>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={
                          !canManageInstallRequests ||
                          request.status !== 'APPROVED_AWAITING_EXECUTION' ||
                          launchAgentInstallRequestMutation.isPending
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRunQueuedRequest(request);
                        }}
                      >
                        Run
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !canManageInstallRequests ||
                          (request.status !== 'APPROVED_AWAITING_EXECUTION' &&
                            request.status !== 'PENDING_APPROVAL') ||
                          cancelAgentInstallRequestMutation.isPending
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          cancelAgentInstallRequestMutation.mutate(request.id);
                        }}
                      >
                        {cancelingInstallRequestId === request.id ? 'Canceling...' : 'Cancel'}
                      </Button>
                      {(request.status === 'FAILED' || request.status === 'SUCCEEDED') && (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={
                            !canManageInstallRequests || deleteAgentInstallRequestMutation.isPending
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            deleteAgentInstallRequestMutation.mutate(request.id);
                          }}
                        >
                          {deletingInstallRequestId === request.id ? 'Deleting...' : 'Delete'}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Request Details &amp; Logs
                </div>
                {!selectedInstallRequest && (
                  <div className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
                    Select an install request to view logs.
                  </div>
                )}
                {selectedInstallRequest && (
                  <div className="space-y-2 rounded-md border border-border/60 p-3">
                    <div className="font-medium">{selectedInstallRequest.id}</div>
                    <div className="text-xs text-muted-foreground">
                      {selectedInstallRequest.action} · {selectedInstallRequest.status}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Target: {selectedInstallRequest.targetUsername}@
                      {selectedInstallRequest.targetHost}:{selectedInstallRequest.targetPort}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Control Plane URL: {selectedInstallRequest.controlPlaneUrl}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Replace existing install:{' '}
                      {selectedInstallRequest.replaceExisting ? 'yes' : 'no'}
                    </div>
                    {selectedInstallRequest.errorMessageSanitized && (
                      <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">
                        {selectedInstallRequest.errorMessageSanitized}
                      </div>
                    )}
                    <div className="max-h-72 space-y-1 overflow-y-auto rounded border border-border/60 bg-background/60 p-2">
                      {(selectedInstallRequest.logs ?? []).length === 0 && (
                        <div className="text-xs text-muted-foreground">No logs yet.</div>
                      )}
                      {(selectedInstallRequest.logs ?? []).map((log: AgentInstallRequestLog) => (
                        <div
                          key={log.id}
                          className="rounded border border-border/40 px-2 py-1 text-xs"
                        >
                          <div className="font-mono text-[10px] text-muted-foreground">
                            #{log.seq} {log.phase} {log.level} ·{' '}
                            {new Date(log.createdAt).toLocaleTimeString()}
                          </div>
                          <div className="whitespace-pre-wrap">{log.message}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Enrollment Tokens</CardTitle>
          <CardDescription>
            Create and revoke enrollment tokens for connected agents.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-md border border-border/60 p-3">
              <div className="font-medium">Control Plane URL</div>
              <div className="text-muted-foreground">
                Pass this value to the installer when prompted for Control plane URL.
              </div>
              <div className="rounded bg-muted/40 px-2 py-1 font-mono text-xs">
                {controlPlaneUrl}
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void copyValue(controlPlaneUrl, 'Control plane URL')}
              >
                Copy URL
              </Button>
            </div>

            <div className="space-y-2 rounded-md border border-border/60 p-3">
              <div className="font-medium">Enrollment Token</div>
              <div className="text-muted-foreground">
                Create a token, then copy it immediately for agent enrollment.
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => createEnrollmentMutation.mutate(24)}
                  disabled={createEnrollmentMutation.isPending}
                >
                  {createEnrollmentMutation.isPending ? 'Creating...' : 'Create 24h Token'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void copyValue(createdEnrollmentToken, 'Enrollment token')}
                  disabled={!createdEnrollmentToken}
                >
                  Copy New Token
                </Button>
              </div>
              {Boolean(createdEnrollmentToken) && (
                <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-200">
                  New token (shown once): {createdEnrollmentToken}
                </div>
              )}
            </div>
          </div>

          {copyStatus && <div className="text-xs text-muted-foreground">{copyStatus}</div>}
          {managementStatus && (
            <div className="text-xs text-muted-foreground">{managementStatus}</div>
          )}

          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Issued Tokens
            </div>
            {(enrollmentTokensQuery.data ?? []).map((token) => (
              <div key={token.id} className="rounded-md border border-border/60 p-3">
                <div className="font-medium">Token ID: {token.id}</div>
                <div className="text-muted-foreground">
                  Expires: {new Date(token.expiresAt).toLocaleString()}
                </div>
                <div className="text-muted-foreground">
                  Revoked: {token.revokedAt ? 'yes' : 'no'}
                </div>
                <div className="mt-2">
                  {token.revokedAt ? (
                    <Button size="sm" variant="secondary" disabled>
                      Revoked
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !canManageEnrollmentTokens || revokeEnrollmentTokenMutation.isPending
                      }
                      onClick={() => revokeEnrollmentTokenMutation.mutate(token.id)}
                    >
                      {revokingEnrollmentTokenId === token.id ? 'Revoking...' : 'Revoke'}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle>Orphan Recovery Claims</CardTitle>
              <CardDescription>
                Review recovery requests from agents trying to reattach after losing control-plane
                state.
              </CardDescription>
            </div>
            {canViewRecoveryClaims && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void agentRecoveryClaimsQuery.refetch()}
              >
                Refresh
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {canViewRecoveryClaims && recoveryActionError && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">
              {recoveryActionError}
            </div>
          )}
          {canViewRecoveryClaims && recoveryActionStatus && (
            <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-200">
              {recoveryActionStatus}
            </div>
          )}
          {canViewRecoveryClaims && agentRecoveryClaimsQuery.isError && (
            <div className="text-xs text-rose-400">Failed to load recovery claims.</div>
          )}
          {canViewRecoveryClaims &&
            !agentRecoveryClaimsQuery.isError &&
            recoveryClaims.length === 0 && (
              <div className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
                No orphan recovery claims are waiting for review.
              </div>
            )}

          {canViewRecoveryClaims && recoveryClaims.length > 0 && (
            <div className="grid gap-3 xl:grid-cols-2">
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Pending And Historical Claims
                </div>
                {recoveryClaims.map((claim) => (
                  <button
                    key={claim.id}
                    type="button"
                    className={`w-full rounded-md border border-border/60 p-3 text-left transition hover:border-border ${selectedRecoveryClaimId === claim.id ? 'border-sky-400/60 bg-secondary/20' : ''}`}
                    onClick={() => setSelectedRecoveryClaimId(claim.id)}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-medium">{recoveryClaimLabel(claim)}</div>
                        <div className="text-xs text-muted-foreground">
                          {claim.hostname}
                          {claim.primaryIp ? ` · ${claim.primaryIp}` : ''}
                        </div>
                      </div>
                      <div className="rounded border border-border/60 px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                        {formatStatusLabel(claim.status)}
                      </div>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      Last seen {formatTimestamp(claim.lastSeenAt)}
                    </div>
                    <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {claim.recoveryKeyFingerprint}
                    </div>
                  </button>
                ))}
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Claim Detail
                </div>
                {!selectedRecoveryClaim && (
                  <div className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
                    Select a recovery claim to inspect it.
                  </div>
                )}
                {selectedRecoveryClaimQuery.isError && selectedRecoveryClaimId && (
                  <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">
                    Failed to load recovery claim detail.
                  </div>
                )}
                {selectedRecoveryClaim && (
                  <div className="space-y-4 rounded-md border border-border/60 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-medium">
                          {recoveryClaimLabel(selectedRecoveryClaim)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {selectedRecoveryClaim.hostname}
                          {selectedRecoveryClaim.primaryIp
                            ? ` · ${selectedRecoveryClaim.primaryIp}`
                            : ''}
                        </div>
                      </div>
                      <div className="rounded border border-border/60 px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                        {formatStatusLabel(selectedRecoveryClaim.status)}
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">
                          Display Name
                        </div>
                        <div>{selectedRecoveryClaim.displayName || '-'}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">
                          Agent Version
                        </div>
                        <div>{selectedRecoveryClaim.agentVersion || '-'}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">Endpoint</div>
                        <div className="break-all">{selectedRecoveryClaim.endpoint}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">
                          MCP Endpoint
                        </div>
                        <div className="break-all">{selectedRecoveryClaim.mcpEndpoint}</div>
                      </div>
                      <div className="space-y-1 md:col-span-2">
                        <div className="text-xs font-medium text-muted-foreground">
                          Recovery Key Fingerprint
                        </div>
                        <div className="break-all font-mono text-xs">
                          {selectedRecoveryClaim.recoveryKeyFingerprint}
                        </div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">
                          Key Algorithm
                        </div>
                        <div>{selectedRecoveryClaim.recoveryKeyAlg}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">Tags</div>
                        <div className="flex flex-wrap gap-1">
                          {selectedRecoveryClaim.tags.length === 0 && (
                            <span className="text-muted-foreground">-</span>
                          )}
                          {selectedRecoveryClaim.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded border border-border/60 px-2 py-0.5 text-xs text-muted-foreground"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">First Seen</div>
                        <div>{formatTimestamp(selectedRecoveryClaim.firstSeenAt)}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">Last Seen</div>
                        <div>{formatTimestamp(selectedRecoveryClaim.lastSeenAt)}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">Approved</div>
                        <div>{formatTimestamp(selectedRecoveryClaim.approvedAt)}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">Denied</div>
                        <div>{formatTimestamp(selectedRecoveryClaim.deniedAt)}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">Completed</div>
                        <div>{formatTimestamp(selectedRecoveryClaim.completedAt)}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">
                          Linked Agent
                        </div>
                        <div>
                          {selectedRecoveryClaim.agent
                            ? `${selectedRecoveryClaim.agent.id} · ${selectedRecoveryClaim.agent.status}`
                            : '-'}
                        </div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">Approved By</div>
                        <div>
                          {selectedRecoveryClaim.approvedBy
                            ? `${selectedRecoveryClaim.approvedBy.displayName} (${selectedRecoveryClaim.approvedBy.email})`
                            : '-'}
                        </div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">Denied By</div>
                        <div>
                          {selectedRecoveryClaim.deniedBy
                            ? `${selectedRecoveryClaim.deniedBy.displayName} (${selectedRecoveryClaim.deniedBy.email})`
                            : '-'}
                        </div>
                      </div>
                    </div>

                    {selectedRecoveryClaim.denialReason && (
                      <div className="rounded border border-border/60 bg-background/60 p-3 text-xs">
                        <div className="font-medium text-muted-foreground">
                          Recorded Denial Reason
                        </div>
                        <div className="mt-1 whitespace-pre-wrap">
                          {selectedRecoveryClaim.denialReason}
                        </div>
                      </div>
                    )}

                    <div className="space-y-1">
                      <label
                        htmlFor="recovery-deny-reason"
                        className="text-xs font-medium text-muted-foreground"
                      >
                        Denial Reason
                      </label>
                      <Textarea
                        id="recovery-deny-reason"
                        value={recoveryDenyReason}
                        onChange={(event) => setRecoveryDenyReason(event.target.value)}
                        rows={3}
                        placeholder="Required to deny a recovery claim"
                        disabled={
                          !canActOnRecoveryClaims ||
                          selectedRecoveryClaim.status !== 'PENDING_APPROVAL' ||
                          approveRecoveryClaimMutation.isPending ||
                          denyRecoveryClaimMutation.isPending
                        }
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        disabled={
                          !canActOnRecoveryClaims ||
                          selectedRecoveryClaim.status !== 'PENDING_APPROVAL' ||
                          approveRecoveryClaimMutation.isPending ||
                          denyRecoveryClaimMutation.isPending
                        }
                        onClick={() =>
                          approveRecoveryClaimMutation.mutate(selectedRecoveryClaim.id)
                        }
                      >
                        {approvingRecoveryClaimId === selectedRecoveryClaim.id
                          ? 'Approving...'
                          : 'Approve Claim'}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={
                          !canActOnRecoveryClaims ||
                          selectedRecoveryClaim.status !== 'PENDING_APPROVAL' ||
                          recoveryDenyReason.trim().length === 0 ||
                          approveRecoveryClaimMutation.isPending ||
                          denyRecoveryClaimMutation.isPending
                        }
                        onClick={() =>
                          denyRecoveryClaimMutation.mutate({
                            claimId: selectedRecoveryClaim.id,
                            body: {
                              confirm: true,
                              reason: recoveryDenyReason.trim(),
                            },
                          })
                        }
                      >
                        {denyingRecoveryClaimId === selectedRecoveryClaim.id
                          ? 'Denying...'
                          : 'Deny Claim'}
                      </Button>
                      {canActOnRecoveryClaims &&
                        selectedRecoveryClaim.status !== 'PENDING_APPROVAL' && (
                          <span className="text-xs text-muted-foreground">
                            Only claims in `PENDING_APPROVAL` can be approved or denied.
                          </span>
                        )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle>Connected Agents</CardTitle>
              <CardDescription>
                Revoke, uninstall, or delete connected agents from the built-in admin account.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowRevokedAgents((current) => !current)}
              disabled={revokedCount === 0}
            >
              {showRevokedAgents ? 'Hide revoked' : `Show revoked (${revokedCount})`}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {agentActionFeedback && (
            <div
              role={agentActionFeedback.tone === 'error' ? 'alert' : 'status'}
              className={
                agentActionFeedback.tone === 'error'
                  ? 'rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300'
                  : 'rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-200'
              }
            >
              {agentActionFeedback.message}
            </div>
          )}
          {visibleAgents.map((agent) => {
            const activeUninstallRequest = activeUninstallRequestsByAgentId.get(agent.id) ?? null;
            const uninstallButtonLabel =
              uninstallingAgentId === agent.id
                ? 'Queueing uninstall...'
                : activeUninstallRequest?.status === 'RUNNING'
                  ? 'Uninstall Running'
                  : activeUninstallRequest
                    ? 'Uninstall Queued'
                    : 'Uninstall Agent';

            return (
              <div key={agent.id} className="rounded-md border border-border/60 p-3">
                <div className="font-medium">
                  {agent.displayName ?? agent.host?.hostname ?? agent.id}
                </div>
                <div className="text-muted-foreground">Status: {agent.status}</div>
                <div className="text-muted-foreground">
                  Last seen: {agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : '-'}
                </div>
                {agent.revokedAt ? (
                  <div className="mt-2 flex items-center gap-2">
                    <Button size="sm" variant="secondary" disabled>
                      Revoked
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => deleteRevokedAgentMutation.mutate(agent.id)}
                      disabled={!canDeleteRevokedAgents || deleteRevokedAgentMutation.isPending}
                    >
                      {deletingAgentId === agent.id ? 'Deleting...' : 'Delete'}
                    </Button>
                  </div>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => revokeAgentMutation.mutate(agent.id)}
                      disabled={!canRevokeAgents || revokeAgentMutation.isPending}
                    >
                      {revokingAgentId === agent.id ? 'Revoking...' : 'Revoke Token'}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => uninstallAgentMutation.mutate(agent.id)}
                      disabled={
                        !canRevokeAgents ||
                        !installFeatureEnabled ||
                        uninstallAgentMutation.isPending ||
                        Boolean(activeUninstallRequest)
                      }
                    >
                      {uninstallButtonLabel}
                    </Button>
                  </div>
                )}
                {!agent.revokedAt && activeUninstallRequest && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 p-2 text-xs text-sky-200">
                    <span>{formatStatusLabel(activeUninstallRequest.status)}</span>
                    <span className="break-all">Request: {activeUninstallRequest.id}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => revealInstallQueueRequest(activeUninstallRequest.id)}
                    >
                      View in Queue
                    </Button>
                  </div>
                )}
                {!installFeatureEnabled && !agent.revokedAt && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    Agent install feature is disabled on the API.
                  </div>
                )}
              </div>
            );
          })}
          {visibleAgents.length === 0 && (
            <div className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
              No agents in the current view.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
