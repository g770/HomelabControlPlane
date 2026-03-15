/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module bootstraps the web client and mounts the React application.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { App } from './app';
import { AuthProvider } from './hooks/use-auth';
import { applyUiThemeSettings, readStoredUiThemeSettings } from './lib/ui-theme';
import './styles.css';

// Apply persisted theme before first render to reduce visual flicker.
const storedThemeSettings = readStoredUiThemeSettings();
applyUiThemeSettings(storedThemeSettings);

// Shared query defaults tuned for operational UIs with frequent updates.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

// Mount the dashboard once the shared providers are ready.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
      </AuthProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  </React.StrictMode>,
);
