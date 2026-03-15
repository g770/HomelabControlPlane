/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module defines the top-level route tree for the authenticated web console.
 */
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AppShell } from '@/components/app-shell';
import { ProtectedRoute } from '@/components/protected-route';
import { useAuth } from '@/hooks/use-auth';
import { useEventsStream } from '@/hooks/use-events-stream';
import { AiPage } from '@/pages/ai-page';
import { AgentManagementPage } from '@/pages/agent-management-page';
import { AlertsPage } from '@/pages/alerts-page';
import { MonitorDetailPage } from '@/pages/check-detail-page';
import { MonitorsPage } from '@/pages/checks-page';
import { DashboardAgentPage } from '@/pages/dashboard-agent-page';
import { HostDetailPage } from '@/pages/host-detail-page';
import { HostsPage } from '@/pages/hosts-page';
import { LoginPage } from '@/pages/login-page';
import { LinksPage } from '@/pages/links-page';
import { ProxmoxPage } from '@/pages/proxmox-page';
import { ServiceDiscoveryPage } from '@/pages/service-discovery-page';
import { SettingsPage } from '@/pages/settings-page';

// Top-level route table for the authenticated web console.
export function App() {
  const { token } = useAuth();
  useEventsStream(Boolean(token));

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route path="/dashboard" element={<LinksPage />} />
            <Route path="/home" element={<Navigate to="/dashboard" replace />} />
            <Route path="/hosts" element={<HostsPage />} />
            <Route path="/hosts/:id" element={<HostDetailPage />} />
            <Route path="/proxmox" element={<ProxmoxPage />} />
            <Route path="/links" element={<Navigate to="/dashboard" replace />} />
            <Route path="/monitors" element={<MonitorsPage />} />
            <Route path="/monitors/:id" element={<MonitorDetailPage />} />
            <Route path="/checks" element={<Navigate to="/monitors" replace />} />
            <Route path="/checks/:id" element={<LegacyCheckRedirect />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/service-discovery" element={<ServiceDiscoveryPage />} />
            <Route path="/agent-management" element={<AgentManagementPage />} />
            <Route path="/ai" element={<AiPage />} />
            <Route path="/dashboard-agent" element={<DashboardAgentPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

// Backward-compatible redirect for legacy /checks/:id links.
function LegacyCheckRedirect() {
  const params = useParams();
  return <Navigate to={params.id ? `/monitors/${params.id}` : '/monitors'} replace />;
}
