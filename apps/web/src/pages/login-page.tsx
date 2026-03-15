/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the login page route view.
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { apiClient } from '@/lib/api';

// Authentication entrypoint with redirect back to the originally requested route.
export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, setup } = useAuth();
  const [setupRequired, setSetupRequired] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  useEffect(() => {
    let active = true;

    void apiClient
      .getSetupStatus()
      .then((result) => {
        if (!active) {
          return;
        }
        setSetupRequired(result.setupRequired);
      })
      .catch((err) => {
        if (!active) {
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load auth status');
      })
      .finally(() => {
        if (!active) {
          return;
        }
        setStatusLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  if (statusLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4 text-sm text-muted-foreground">
        Loading authentication...
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{setupRequired ? 'Set Admin Password' : 'Sign in'}</CardTitle>
          <CardDescription>
            {setupRequired
              ? 'Finish first-run setup by creating the local admin password.'
              : 'Authenticate to access your homelab control plane.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              setError(null);
              if (setupRequired && password !== confirmPassword) {
                setError('Passwords do not match');
                return;
              }
              setLoading(true);
              try {
                if (setupRequired) {
                  await setup(password);
                } else {
                  await login(password);
                }
                void navigate(from, { replace: true });
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Login failed');
              } finally {
                setLoading(false);
              }
            }}
          >
            <div className="space-y-1">
              <label htmlFor="login-password" className="text-sm text-muted-foreground">
                Password
              </label>
              <Input
                id="login-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {setupRequired && (
              <div className="space-y-1">
                <label htmlFor="login-confirm-password" className="text-sm text-muted-foreground">
                  Confirm Password
                </label>
                <Input
                  id="login-confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </div>
            )}
            {error && <p className="text-sm text-rose-400">{error}</p>}
            <Button disabled={loading} type="submit" className="w-full">
              {loading
                ? setupRequired
                  ? 'Saving...'
                  : 'Signing in...'
                : setupRequired
                  ? 'Set Password'
                  : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
