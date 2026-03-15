/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the settings page route view.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UiThemeSettings } from '@homelab/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api';
import {
  applyUiThemeSettings,
  buildUiThemePresetSettings,
  defaultUiThemeSettings,
  normalizeUiThemeSettings,
  persistUiThemeSettings,
  uiThemeModeOptions,
  uiThemePaletteOptions,
  uiThemePresetOptions,
  uiThemeStyleOptions,
} from '@/lib/ui-theme';
import { PageSkeleton } from '@/components/page-skeleton';
import type {
  AiProviderConfigResponse,
  DashboardAgentConfigResponse,
  IntegrationDeleteResponse,
  NotificationRouteSummary,
  ProxmoxIntegrationSummary,
} from '@/types/api';

type ProxmoxIntegrationDraft = {
  name: string;
  baseUrl: string;
  apiTokenId: string;
  apiTokenSecret: string;
  allowInsecureTls: boolean;
  enabled: boolean;
};

/**
 * Creates default proxmox integration draft.
 */
function createDefaultProxmoxIntegrationDraft(): ProxmoxIntegrationDraft {
  return {
    name: 'Proxmox Lab',
    baseUrl: 'https://proxmox.local:8006',
    apiTokenId: '',
    apiTokenSecret: '',
    allowInsecureTls: false,
    enabled: true,
  };
}

/**
 * Implements format count.
 */
function formatCount(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Builds integration delete status.
 */
function buildIntegrationDeleteStatus(name: string, result: IntegrationDeleteResponse) {
  return `Integration "${name}" deleted. Removed ${formatCount(result.deletedServiceCount, 'service')}, ${formatCount(result.deletedServiceInstanceCount, 'service instance')}, and ${formatCount(result.deletedHostCount, 'orphan host')}.`;
}

// Administrative settings surface for auth, integrations, AI personality, and UI theme customization.
export function SettingsPage() {
  const queryClient = useQueryClient();

  const integrationsQuery = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiFetch<ProxmoxIntegrationSummary[]>('/api/integrations'),
  });
  const routesQuery = useQuery({
    queryKey: ['notification-routes'],
    queryFn: () => apiFetch<NotificationRouteSummary[]>('/api/notification-routes'),
  });
  const aiPersonalityQuery = useQuery({
    queryKey: ['ai-personality'],
    queryFn: () =>
      apiFetch<{ personality: string; isCustom: boolean; updatedAt: string | null }>(
        '/api/ai/personality',
      ),
  });
  const aiProviderQuery = useQuery({
    queryKey: ['ai-provider'],
    queryFn: () => apiFetch<AiProviderConfigResponse>('/api/ai/provider'),
  });
  const dashboardAgentConfigQuery = useQuery({
    queryKey: ['dashboard-agent-config'],
    queryFn: () => apiFetch<DashboardAgentConfigResponse>('/api/dashboard-agent/config'),
  });
  const uiThemeQuery = useQuery({
    queryKey: ['ui-theme'],
    queryFn: () =>
      apiFetch<{
        theme: UiThemeSettings;
        isCustom: boolean;
        updatedAt: string | null;
      }>('/api/account/theme'),
  });

  const [editingIntegrationId, setEditingIntegrationId] = useState<string | null>(null);
  const [integrationDraft, setIntegrationDraft] = useState<ProxmoxIntegrationDraft>(
    createDefaultProxmoxIntegrationDraft,
  );
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [integrationStatus, setIntegrationStatus] = useState<string | null>(null);
  const [uiThemeDraft, setUiThemeDraft] = useState<UiThemeSettings>(defaultUiThemeSettings);
  const [uiThemeDirty, setUiThemeDirty] = useState(false);
  const [aiProviderApiKey, setAiProviderApiKey] = useState('');
  const [aiProviderError, setAiProviderError] = useState<string | null>(null);
  const [aiProviderStatus, setAiProviderStatus] = useState<string | null>(null);
  const [aiPersonalityDraft, setAiPersonalityDraft] = useState('');
  const [aiPersonalityDirty, setAiPersonalityDirty] = useState(false);
  const [dashboardAgentEnabled, setDashboardAgentEnabled] = useState(true);
  const [dashboardAgentIntervalSec, setDashboardAgentIntervalSec] = useState('300');
  const [dashboardAgentEscalateCreateEvents, setDashboardAgentEscalateCreateEvents] =
    useState(true);
  const [dashboardAgentPersonality, setDashboardAgentPersonality] = useState('');
  const [dashboardAgentDirty, setDashboardAgentDirty] = useState(false);
  const [dashboardAgentError, setDashboardAgentError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!uiThemeQuery.data || uiThemeDirty) {
      return;
    }
    // Keep preview/theme persistence in sync with server state when not editing.
    const normalized = normalizeUiThemeSettings(uiThemeQuery.data.theme);
    setUiThemeDraft(normalized);
    applyUiThemeSettings(normalized);
    persistUiThemeSettings(normalized);
  }, [uiThemeDirty, uiThemeQuery.data]);

  useEffect(() => {
    if (!aiPersonalityQuery.data || aiPersonalityDirty) {
      return;
    }
    setAiPersonalityDraft(aiPersonalityQuery.data.personality);
  }, [aiPersonalityDirty, aiPersonalityQuery.data]);

  useEffect(() => {
    if (!dashboardAgentConfigQuery.data || dashboardAgentDirty) {
      return;
    }
    setDashboardAgentEnabled(dashboardAgentConfigQuery.data.config.enabled);
    setDashboardAgentIntervalSec(String(dashboardAgentConfigQuery.data.config.intervalSec));
    setDashboardAgentEscalateCreateEvents(
      dashboardAgentConfigQuery.data.config.escalateCreateEvents,
    );
    setDashboardAgentPersonality(dashboardAgentConfigQuery.data.config.personality);
    setDashboardAgentError(null);
  }, [dashboardAgentConfigQuery.data, dashboardAgentDirty]);

  const saveIntegrationMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch('/api/integrations', {
        method: 'POST',
        body: JSON.stringify({
          confirm: true,
          ...payload,
        }),
      }),
    onMutate: () => {
      setIntegrationError(null);
      setIntegrationStatus(null);
    },
    onSuccess: async (_result, variables) => {
      setEditingIntegrationId(null);
      setIntegrationDraft(createDefaultProxmoxIntegrationDraft());
      setIntegrationStatus(
        variables.id
          ? `Updated Proxmox integration "${variables.name}".`
          : `Saved Proxmox integration "${variables.name}".`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['proxmox-integrations'] }),
        queryClient.invalidateQueries({ queryKey: ['integrations'] }),
      ]);
    },
    onError: (error) => {
      setIntegrationError(
        error instanceof Error ? error.message : 'Failed to save the Proxmox integration.',
      );
    },
  });

  const deleteIntegrationMutation = useMutation({
    mutationFn: ({ id }: { id: string; name: string }) =>
      apiFetch<IntegrationDeleteResponse>(`/api/integrations/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({
          confirm: true,
        }),
      }),
    onMutate: () => {
      setIntegrationError(null);
      setIntegrationStatus(null);
    },
    onSuccess: async (result, variables) => {
      if (editingIntegrationId === variables.id) {
        resetIntegrationForm();
      }
      setIntegrationStatus(buildIntegrationDeleteStatus(variables.name, result));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['proxmox-integrations'] }),
        queryClient.invalidateQueries({ queryKey: ['integrations'] }),
        queryClient.invalidateQueries({ queryKey: ['hosts'] }),
        queryClient.invalidateQueries({ queryKey: ['services'] }),
        queryClient.invalidateQueries({ queryKey: ['checks'] }),
        queryClient.invalidateQueries({ queryKey: ['home-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['events'] }),
        queryClient.invalidateQueries({ queryKey: ['alerts-incidents'] }),
      ]);
    },
    onError: (error, variables) => {
      setIntegrationError(
        error instanceof Error
          ? error.message
          : `Failed to delete integration "${variables.name}".`,
      );
    },
  });

  const saveAiPersonalityMutation = useMutation({
    mutationFn: (personality: string) =>
      apiFetch<{ personality: string; isCustom: boolean; updatedAt: string | null }>(
        '/api/ai/personality',
        {
          method: 'PUT',
          body: JSON.stringify({
            confirm: true,
            personality,
          }),
        },
      ),
    onSuccess: async (result) => {
      setAiPersonalityDraft(result.personality);
      setAiPersonalityDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['ai-personality'] });
    },
  });

  const saveAiProviderMutation = useMutation({
    mutationFn: (apiKey: string | null) =>
      apiFetch<AiProviderConfigResponse>('/api/ai/provider', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          apiKey,
        }),
      }),
    onMutate: () => {
      setAiProviderError(null);
      setAiProviderStatus(null);
    },
    onSuccess: async (_result, apiKey) => {
      setAiProviderApiKey('');
      setAiProviderStatus(apiKey === null ? 'OpenAI API key cleared.' : 'OpenAI API key saved.');
      await queryClient.invalidateQueries({ queryKey: ['ai-provider'] });
      await queryClient.invalidateQueries({ queryKey: ['ai-status'] });
    },
    onError: (error) => {
      setAiProviderError(
        error instanceof Error ? error.message : 'Failed to update OpenAI API key.',
      );
    },
  });

  const saveUiThemeMutation = useMutation({
    mutationFn: (theme: UiThemeSettings) =>
      apiFetch<{
        theme: UiThemeSettings;
        isCustom: boolean;
        updatedAt: string | null;
      }>('/api/account/theme', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          theme,
        }),
      }),
    onSuccess: async (result) => {
      const normalized = normalizeUiThemeSettings(result.theme);
      setUiThemeDraft(normalized);
      setUiThemeDirty(false);
      applyUiThemeSettings(normalized);
      persistUiThemeSettings(normalized);
      await queryClient.invalidateQueries({ queryKey: ['ui-theme'] });
    },
  });

  const saveDashboardAgentConfigMutation = useMutation({
    mutationFn: (payload: DashboardAgentConfigResponse['config']) =>
      apiFetch<DashboardAgentConfigResponse>('/api/dashboard-agent/config', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          config: payload,
        }),
      }),
    onSuccess: async (result) => {
      setDashboardAgentEnabled(result.config.enabled);
      setDashboardAgentIntervalSec(String(result.config.intervalSec));
      setDashboardAgentEscalateCreateEvents(result.config.escalateCreateEvents);
      setDashboardAgentPersonality(result.config.personality);
      setDashboardAgentDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['dashboard-agent-config'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard-agent-status'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard-agent-runs'] });
    },
  });

  const changePasswordMutation = useMutation({
    mutationFn: (payload: { currentPassword: string; newPassword: string }) =>
      apiFetch<{ ok: true }>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          confirm: true,
          currentPassword: payload.currentPassword,
          newPassword: payload.newPassword,
        }),
      }),
    onMutate: () => {
      setPasswordError(null);
      setPasswordStatus(null);
    },
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordStatus('Admin password updated.');
    },
    onError: (error) => {
      setPasswordError(error instanceof Error ? error.message : 'Failed to update admin password.');
    },
  });

  /**
   * Implements preview ui theme draft.
   */
  const previewUiThemeDraft = (theme: UiThemeSettings, dirty: boolean) => {
    const normalized = normalizeUiThemeSettings(theme);
    setUiThemeDraft(normalized);
    setUiThemeDirty(dirty);
    applyUiThemeSettings(normalized);
    persistUiThemeSettings(normalized);
  };

  /**
   * Implements update ui theme draft.
   */
  const updateUiThemeDraft = (patch: Partial<UiThemeSettings>) => {
    setUiThemeDraft((current) => {
      const paletteChanged = patch.palette !== undefined && patch.palette !== current.palette;
      const styleChanged = patch.style !== undefined && patch.style !== current.style;
      const nextPreset =
        patch.preset ?? (paletteChanged || styleChanged ? 'custom' : current.preset);
      const next = normalizeUiThemeSettings({
        ...current,
        ...patch,
        preset: nextPreset,
      });
      applyUiThemeSettings(next);
      persistUiThemeSettings(next);
      return next;
    });
    setUiThemeDirty(true);
  };

  const selectedPresetOption = uiThemePresetOptions.find(
    (option) => option.id === uiThemeDraft.preset,
  );
  const selectedModeOption = uiThemeModeOptions.find((option) => option.id === uiThemeDraft.mode);
  const selectedPaletteOption = uiThemePaletteOptions.find(
    (option) => option.id === uiThemeDraft.palette,
  );
  const selectedStyleOption = uiThemeStyleOptions.find(
    (option) => option.id === uiThemeDraft.style,
  );
  const deletingIntegrationId = deleteIntegrationMutation.isPending
    ? (deleteIntegrationMutation.variables?.id ?? null)
    : null;

  /**
   * Implements reset integration form.
   */
  const resetIntegrationForm = () => {
    setEditingIntegrationId(null);
    setIntegrationDraft(createDefaultProxmoxIntegrationDraft());
  };

  if (
    integrationsQuery.isLoading ||
    routesQuery.isLoading ||
    aiProviderQuery.isLoading ||
    aiPersonalityQuery.isLoading ||
    dashboardAgentConfigQuery.isLoading ||
    uiThemeQuery.isLoading
  ) {
    return <PageSkeleton />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Admin Password</CardTitle>
          <CardDescription>
            Update the password for the built-in local admin account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              setPasswordError(null);
              setPasswordStatus(null);

              if (newPassword !== confirmPassword) {
                setPasswordError('New passwords do not match.');
                return;
              }

              changePasswordMutation.mutate({
                currentPassword,
                newPassword,
              });
            }}
          >
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground">Current Password</label>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground">New Password</label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground">Confirm New Password</label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </div>
            </div>
            <Button type="submit" disabled={changePasswordMutation.isPending}>
              {changePasswordMutation.isPending ? 'Saving...' : 'Update Password'}
            </Button>
          </form>

          {passwordError && <div className="text-xs text-rose-400">{passwordError}</div>}
          {passwordStatus && <div className="text-xs text-emerald-400">{passwordStatus}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Proxmox Integrations</CardTitle>
          <CardDescription>
            Connect one or more Proxmox clusters with explicit fields instead of raw JSON payloads.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              setIntegrationError(null);
              setIntegrationStatus(null);

              if (!integrationDraft.name.trim()) {
                setIntegrationError('Integration Name is required.');
                return;
              }
              if (!integrationDraft.baseUrl.trim()) {
                setIntegrationError('Base URL is required.');
                return;
              }
              if (!integrationDraft.apiTokenId.trim()) {
                setIntegrationError('API Token ID is required.');
                return;
              }
              if (!editingIntegrationId && !integrationDraft.apiTokenSecret.trim()) {
                setIntegrationError(
                  'API Token Secret is required when creating a Proxmox integration.',
                );
                return;
              }

              saveIntegrationMutation.mutate({
                id: editingIntegrationId ?? undefined,
                name: integrationDraft.name.trim(),
                enabled: integrationDraft.enabled,
                baseUrl: integrationDraft.baseUrl.trim(),
                apiTokenId: integrationDraft.apiTokenId.trim(),
                apiTokenSecret: integrationDraft.apiTokenSecret.trim() || undefined,
                allowInsecureTls: integrationDraft.allowInsecureTls,
              });
            }}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground" htmlFor="proxmox-integration-name">
                  Integration Name
                </label>
                <Input
                  id="proxmox-integration-name"
                  value={integrationDraft.name}
                  onChange={(event) =>
                    /**
                     * Sets integration draft.
                     */
                    setIntegrationDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="Proxmox Lab"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground" htmlFor="proxmox-base-url">
                  Base URL
                </label>
                <Input
                  id="proxmox-base-url"
                  type="url"
                  value={integrationDraft.baseUrl}
                  onChange={(event) =>
                    /**
                     * Sets integration draft.
                     */
                    setIntegrationDraft((current) => ({ ...current, baseUrl: event.target.value }))
                  }
                  placeholder="https://proxmox.local:8006"
                />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground" htmlFor="proxmox-api-token-id">
                  API Token ID
                </label>
                <Input
                  id="proxmox-api-token-id"
                  value={integrationDraft.apiTokenId}
                  onChange={(event) =>
                    setIntegrationDraft((current) => ({
                      ...current,
                      apiTokenId: event.target.value,
                    }))
                  }
                  placeholder="root@pam!dashboard"
                />
                <div className="text-xs text-muted-foreground">
                  Use the Proxmox token identifier, for example <code>root@pam!dashboard</code>.
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground" htmlFor="proxmox-api-token-secret">
                  API Token Secret
                </label>
                <Input
                  id="proxmox-api-token-secret"
                  type="password"
                  value={integrationDraft.apiTokenSecret}
                  onChange={(event) =>
                    setIntegrationDraft((current) => ({
                      ...current,
                      apiTokenSecret: event.target.value,
                    }))
                  }
                  placeholder={
                    editingIntegrationId
                      ? 'Leave blank to keep the current secret'
                      : 'Paste token secret'
                  }
                />
                {editingIntegrationId ? (
                  <div className="text-xs text-muted-foreground">
                    Leave blank to keep the current stored secret.
                  </div>
                ) : null}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
                <input
                  aria-label="Allow insecure TLS"
                  type="checkbox"
                  checked={integrationDraft.allowInsecureTls}
                  onChange={(event) =>
                    setIntegrationDraft((current) => ({
                      ...current,
                      allowInsecureTls: event.target.checked,
                    }))
                  }
                />
                <span>
                  Allow insecure TLS
                  <span className="block text-xs text-muted-foreground">
                    Use only for self-signed or lab certificates you trust.
                  </span>
                </span>
              </label>
              <label className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
                <input
                  aria-label="Enabled"
                  type="checkbox"
                  checked={integrationDraft.enabled}
                  onChange={(event) =>
                    setIntegrationDraft((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                />
                <span>
                  Enabled
                  <span className="block text-xs text-muted-foreground">
                    Enabled integrations appear in the Proxmox tab and can be queried live.
                  </span>
                </span>
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={saveIntegrationMutation.isPending}>
                {saveIntegrationMutation.isPending
                  ? editingIntegrationId
                    ? 'Updating...'
                    : 'Saving...'
                  : editingIntegrationId
                    ? 'Update Integration'
                    : 'Save Integration'}
              </Button>
              {editingIntegrationId ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={resetIntegrationForm}
                  disabled={saveIntegrationMutation.isPending}
                >
                  Cancel Edit
                </Button>
              ) : null}
            </div>
          </form>

          {integrationError && <div className="text-xs text-rose-400">{integrationError}</div>}
          {integrationStatus && <div className="text-xs text-emerald-400">{integrationStatus}</div>}

          <div className="space-y-2 text-sm">
            {(integrationsQuery.data ?? []).map((integration) => (
              <div key={integration.id} className="rounded-md border border-border/60 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="font-medium">{integration.name}</div>
                    <div className="text-xs text-muted-foreground">{integration.baseUrl}</div>
                    <div className="text-xs text-muted-foreground">
                      Token ID: {integration.apiTokenId?.trim() || 'Legacy credential'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {integration.enabled ? 'Enabled' : 'Disabled'}
                      {integration.allowInsecureTls ? ' • Insecure TLS allowed' : ''}
                    </div>
                    {integration.lastStatus ? (
                      <div className="text-xs text-muted-foreground">
                        Last status: {integration.lastStatus}
                        {integration.lastSyncAt
                          ? ` • ${new Date(integration.lastSyncAt).toLocaleString()}`
                          : ''}
                      </div>
                    ) : null}
                    {integration.lastError ? (
                      <div className="text-xs text-rose-400">{integration.lastError}</div>
                    ) : null}
                  </div>
                </div>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={deletingIntegrationId === integration.id}
                    onClick={() => {
                      setEditingIntegrationId(integration.id);
                      setIntegrationError(null);
                      setIntegrationStatus(null);
                      setIntegrationDraft({
                        name: integration.name,
                        baseUrl: integration.baseUrl,
                        apiTokenId: integration.apiTokenId?.trim() ?? '',
                        apiTokenSecret: '',
                        allowInsecureTls: integration.allowInsecureTls,
                        enabled: integration.enabled,
                      });
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={deletingIntegrationId === integration.id}
                    onClick={() =>
                      apiFetch(`/api/integrations/${integration.id}/test`, {
                        method: 'POST',
                        body: JSON.stringify({ confirm: true }),
                      }).then(() =>
                        Promise.all([
                          queryClient.invalidateQueries({ queryKey: ['proxmox-integrations'] }),
                          queryClient.invalidateQueries({ queryKey: ['integrations'] }),
                        ]),
                      )
                    }
                  >
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={deletingIntegrationId === integration.id}
                    onClick={() =>
                      apiFetch(`/api/integrations/${integration.id}/sync`, {
                        method: 'POST',
                        body: JSON.stringify({ confirm: true }),
                      }).then(() => {
                        void queryClient.invalidateQueries({ queryKey: ['proxmox-integrations'] });
                        void queryClient.invalidateQueries({ queryKey: ['integrations'] });
                        void queryClient.invalidateQueries({ queryKey: ['hosts'] });
                        void queryClient.invalidateQueries({ queryKey: ['services'] });
                      })
                    }
                  >
                    Sync
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={deletingIntegrationId === integration.id}
                    onClick={() => {
                      const confirmed = window.confirm(
                        `Delete integration "${integration.name}"? This removes the integration, deletes sourced services and service instances, and attempts orphan-host cleanup. This cannot be undone.`,
                      );
                      if (!confirmed) {
                        return;
                      }
                      deleteIntegrationMutation.mutate({
                        id: integration.id,
                        name: integration.name,
                      });
                    }}
                  >
                    {deletingIntegrationId === integration.id ? 'Deleting...' : 'Delete'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>UI Theme</CardTitle>
          <CardDescription>
            Choose a cinematic preset, then fine-tune the underlying mode, palette, and surface
            treatment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="space-y-2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Preset
                </div>
                <div className="text-xs text-muted-foreground">
                  Presets coordinate typography, surface density, and motion with their color
                  systems.
                </div>
              </div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {selectedPresetOption?.label ?? 'Custom Theme'}
              </div>
            </div>

            <div className="grid gap-3 xl:grid-cols-2">
              {uiThemePresetOptions.map((option) => {
                const active = uiThemeDraft.preset === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`relative overflow-hidden rounded-xl border p-4 text-left transition ${
                      active
                        ? 'border-primary/70 bg-secondary/20 shadow-lg shadow-primary/10'
                        : 'border-border/60 bg-background/50 hover:border-primary/40 hover:bg-secondary/20'
                    }`}
                    onClick={() => previewUiThemeDraft(buildUiThemePresetSettings(option.id), true)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="font-display text-sm font-semibold">{option.label}</div>
                        <div className="text-xs text-muted-foreground">{option.description}</div>
                      </div>
                      <span
                        className={`rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${
                          active
                            ? 'border-primary/40 text-primary'
                            : 'border-border/60 text-muted-foreground'
                        }`}
                      >
                        {active ? 'Active' : 'Preset'}
                      </span>
                    </div>

                    <div className="mt-4 flex gap-2">
                      {option.swatches.map((swatch) => (
                        <span
                          key={swatch}
                          className="h-2.5 flex-1 rounded-full border border-white/10"
                          style={{ backgroundColor: swatch }}
                        />
                      ))}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                      <span>{option.motifLabel}</span>
                      <span>{option.fontLabel}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-background/50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-display text-sm font-semibold">Expert Overrides</div>
                <div className="text-xs text-muted-foreground">
                  Mode changes keep the active preset. Palette or style changes save as a custom
                  variant.
                </div>
              </div>
              <div className="rounded-full border border-border/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {selectedPresetOption ? `Preset: ${selectedPresetOption.label}` : 'Preset: Custom'}
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Mode
                </div>
                <Select
                  aria-label="Theme Mode"
                  value={uiThemeDraft.mode}
                  onChange={(event) =>
                    updateUiThemeDraft({
                      mode: event.target.value as UiThemeSettings['mode'],
                    })
                  }
                >
                  {uiThemeModeOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <div className="text-xs text-muted-foreground">
                  {selectedModeOption?.description}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Palette
                </div>
                <Select
                  aria-label="Theme Palette"
                  value={uiThemeDraft.palette}
                  onChange={(event) =>
                    updateUiThemeDraft({
                      palette: event.target.value as UiThemeSettings['palette'],
                    })
                  }
                >
                  {uiThemePaletteOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <div className="text-xs text-muted-foreground">
                  {selectedPaletteOption?.description}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Style
                </div>
                <Select
                  aria-label="Theme Style"
                  value={uiThemeDraft.style}
                  onChange={(event) =>
                    updateUiThemeDraft({
                      style: event.target.value as UiThemeSettings['style'],
                    })
                  }
                >
                  {uiThemeStyleOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <div className="text-xs text-muted-foreground">
                  {selectedStyleOption?.description}
                </div>
              </div>
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            {uiThemeQuery.data?.isCustom ? 'Custom theme saved.' : 'Preset saved.'}{' '}
            {uiThemeQuery.data?.updatedAt
              ? `Last updated ${new Date(uiThemeQuery.data.updatedAt).toLocaleString()}.`
              : ''}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                previewUiThemeDraft(
                  normalizeUiThemeSettings(uiThemeQuery.data?.theme ?? defaultUiThemeSettings),
                  false,
                );
              }}
            >
              Revert
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                previewUiThemeDraft(normalizeUiThemeSettings(defaultUiThemeSettings), true);
              }}
            >
              Use Default Theme
            </Button>
            <Button
              size="sm"
              disabled={saveUiThemeMutation.isPending || !uiThemeDirty}
              onClick={() => saveUiThemeMutation.mutate(uiThemeDraft)}
            >
              {saveUiThemeMutation.isPending ? 'Saving...' : 'Save Theme'}
            </Button>
          </div>

          {saveUiThemeMutation.isError && (
            <div className="text-xs text-rose-400">Failed to save theme preferences.</div>
          )}
          {saveUiThemeMutation.isSuccess && (
            <div className="text-xs text-emerald-400">Theme preferences saved.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI Provider</CardTitle>
          <CardDescription>
            Configure the installation-wide OpenAI API key used by model-backed AI features.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="text-xs text-muted-foreground">
            {aiProviderQuery.data?.configured
              ? 'OpenAI API key is configured.'
              : 'OpenAI API key is not configured.'}{' '}
            Model: {aiProviderQuery.data?.model ?? 'gpt-5-mini'}.
            {aiProviderQuery.data?.updatedAt
              ? ` Last updated ${new Date(aiProviderQuery.data.updatedAt).toLocaleString()}.`
              : ''}
          </div>
          <div className="space-y-1">
            <label htmlFor="ai-provider-api-key" className="text-sm text-muted-foreground">
              OpenAI API Key
            </label>
            <Input
              id="ai-provider-api-key"
              type="password"
              value={aiProviderApiKey}
              autoComplete="new-password"
              placeholder={
                aiProviderQuery.data?.configured
                  ? 'Enter a replacement key'
                  : 'Enter a key to enable AI features'
              }
              onChange={(event) => setAiProviderApiKey(event.target.value)}
            />
            <div className="text-xs text-muted-foreground">
              The key is write-only from the UI and takes effect without restarting the stack.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={saveAiProviderMutation.isPending}
              onClick={() => {
                const trimmed = aiProviderApiKey.trim();
                if (trimmed.length === 0) {
                  setAiProviderError('Enter an OpenAI API key or use Clear Key.');
                  setAiProviderStatus(null);
                  return;
                }
                saveAiProviderMutation.mutate(trimmed);
              }}
            >
              {saveAiProviderMutation.isPending ? 'Saving...' : 'Save Key'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={saveAiProviderMutation.isPending || !aiProviderQuery.data?.configured}
              onClick={() => saveAiProviderMutation.mutate(null)}
            >
              {saveAiProviderMutation.isPending ? 'Clearing...' : 'Clear Key'}
            </Button>
          </div>
          {aiProviderError && <div className="text-xs text-rose-400">{aiProviderError}</div>}
          {aiProviderStatus && <div className="text-xs text-emerald-400">{aiProviderStatus}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI Personality</CardTitle>
          <CardDescription>
            Define an English-language personality profile applied to model-backed AI calls.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Textarea
            value={aiPersonalityDraft}
            onChange={(event) => {
              setAiPersonalityDraft(event.target.value);
              setAiPersonalityDirty(true);
            }}
            rows={8}
            placeholder="Describe tone, behavior, communication style, and priorities for your AI assistant."
          />
          <div className="text-xs text-muted-foreground">
            {aiPersonalityQuery.data?.isCustom
              ? 'Custom personality active.'
              : 'Default personality active.'}{' '}
            {aiPersonalityQuery.data?.updatedAt
              ? `Last updated ${new Date(aiPersonalityQuery.data.updatedAt).toLocaleString()}.`
              : ''}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setAiPersonalityDraft('');
                setAiPersonalityDirty(true);
              }}
            >
              Use Default Personality
            </Button>
            <Button
              size="sm"
              disabled={saveAiPersonalityMutation.isPending || !aiPersonalityDirty}
              onClick={() => saveAiPersonalityMutation.mutate(aiPersonalityDraft)}
            >
              {saveAiPersonalityMutation.isPending ? 'Saving...' : 'Save Personality'}
            </Button>
          </div>
          {saveAiPersonalityMutation.isError && (
            <div className="text-xs text-rose-400">Failed to save personality.</div>
          )}
          {saveAiPersonalityMutation.isSuccess && (
            <div className="text-xs text-emerald-400">Personality saved.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dashboard Agent</CardTitle>
          <CardDescription>
            Configure the read-only background agent loop and global persona used for anomaly
            triage.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={dashboardAgentEnabled}
              onChange={(event) => {
                setDashboardAgentEnabled(event.target.checked);
                setDashboardAgentDirty(true);
                setDashboardAgentError(null);
              }}
            />
            Enable Dashboard Agent schedule
          </label>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Loop Interval (seconds)
              </div>
              <Input
                type="number"
                min={60}
                max={86_400}
                step={1}
                value={dashboardAgentIntervalSec}
                onChange={(event) => {
                  setDashboardAgentIntervalSec(event.target.value);
                  setDashboardAgentDirty(true);
                  setDashboardAgentError(null);
                }}
              />
              <div className="text-xs text-muted-foreground">Valid range: 60 to 86400 seconds.</div>
            </div>
            <label className="flex items-center gap-2 self-end">
              <input
                type="checkbox"
                checked={dashboardAgentEscalateCreateEvents}
                onChange={(event) => {
                  setDashboardAgentEscalateCreateEvents(event.target.checked);
                  setDashboardAgentDirty(true);
                }}
              />
              Emit events for high-priority findings
            </label>
          </div>

          <div className="space-y-1">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Global Persona
            </div>
            <Textarea
              rows={6}
              value={dashboardAgentPersonality}
              onChange={(event) => {
                setDashboardAgentPersonality(event.target.value);
                setDashboardAgentDirty(true);
              }}
              placeholder={dashboardAgentConfigQuery.data?.defaultPersonality}
            />
            <div className="text-xs text-muted-foreground">
              Leave blank to use the built-in default personality.
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            {dashboardAgentConfigQuery.data?.updatedAt
              ? `Last updated ${new Date(dashboardAgentConfigQuery.data.updatedAt).toLocaleString()}.`
              : ''}
          </div>

          {dashboardAgentError && (
            <div className="text-xs text-rose-400">{dashboardAgentError}</div>
          )}
          {saveDashboardAgentConfigMutation.isError && (
            <div className="text-xs text-rose-400">Failed to save Dashboard Agent settings.</div>
          )}
          {saveDashboardAgentConfigMutation.isSuccess && !dashboardAgentDirty && (
            <div className="text-xs text-emerald-400">Dashboard Agent settings saved.</div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (!dashboardAgentConfigQuery.data) {
                  return;
                }
                setDashboardAgentEnabled(dashboardAgentConfigQuery.data.config.enabled);
                setDashboardAgentIntervalSec(
                  String(dashboardAgentConfigQuery.data.config.intervalSec),
                );
                setDashboardAgentEscalateCreateEvents(
                  dashboardAgentConfigQuery.data.config.escalateCreateEvents,
                );
                setDashboardAgentPersonality(dashboardAgentConfigQuery.data.config.personality);
                setDashboardAgentDirty(false);
                setDashboardAgentError(null);
              }}
            >
              Revert
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDashboardAgentPersonality('');
                setDashboardAgentDirty(true);
              }}
            >
              Use Default Persona
            </Button>
            <Button
              size="sm"
              disabled={saveDashboardAgentConfigMutation.isPending || !dashboardAgentDirty}
              onClick={() => {
                const parsedInterval = Number(dashboardAgentIntervalSec.trim());
                if (!Number.isFinite(parsedInterval) || !Number.isInteger(parsedInterval)) {
                  setDashboardAgentError('Loop interval must be a whole number.');
                  return;
                }
                if (parsedInterval < 60 || parsedInterval > 86_400) {
                  setDashboardAgentError('Loop interval must be between 60 and 86400 seconds.');
                  return;
                }

                setDashboardAgentError(null);
                saveDashboardAgentConfigMutation.mutate({
                  enabled: dashboardAgentEnabled,
                  intervalSec: parsedInterval,
                  escalateCreateEvents: dashboardAgentEscalateCreateEvents,
                  personality: dashboardAgentPersonality,
                });
              }}
            >
              {saveDashboardAgentConfigMutation.isPending ? 'Saving...' : 'Save Dashboard Agent'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notification Routes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {(routesQuery.data ?? []).map((route) => (
            <div key={route.id} className="rounded-md border border-border/60 p-3">
              <div className="font-medium">{route.name}</div>
              <div className="text-muted-foreground">{route.type}</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
