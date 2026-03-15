/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This hook module coordinates the use auth client-side behavior.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiClient } from '@/lib/api';
import { clearToken, getToken, setToken } from '@/lib/auth';

// Minimal authenticated user shape stored by the client runtime.
type AuthUser = {
  id: string;
  displayName: string;
};

// Auth context contract shared by the provider and hook consumers.
type AuthContextType = {
  token: string | null;
  user: AuthUser | null;
  loading: boolean;
  login: (password: string) => Promise<void>;
  setup: (password: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Provides auth session state and mutation helpers to the dashboard tree.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Keep the in-memory profile aligned with the currently persisted token.
  const refreshMe = useCallback(async () => {
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }

    try {
      const me = await apiClient.me();
      setUser(me);
    } catch {
      clearToken();
      setTokenState(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  // Memoize the context value so consumers only rerender on auth state changes.
  const value = useMemo<AuthContextType>(
    () => ({
      token,
      user,
      loading,
      login: async (password: string) => {
        const response = await apiClient.login({ password });
        setToken(response.accessToken);
        setTokenState(response.accessToken);
      },
      setup: async (password: string) => {
        const response = await apiClient.setupAdmin({
          confirm: true,
          password,
        });
        setToken(response.accessToken);
        setTokenState(response.accessToken);
      },
      logout: () => {
        clearToken();
        setTokenState(null);
        setUser(null);
      },
      refreshMe,
    }),
    [token, user, loading, refreshMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Returns the current auth context and enforces provider usage.
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }

  return context;
}
