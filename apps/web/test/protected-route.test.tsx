/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the protected route test UI behavior.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from '@/components/protected-route';

const useAuthMock = vi.fn();

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => useAuthMock(),
}));

describe('ProtectedRoute', () => {
  it('renders a loading state while session is resolving', () => {
    useAuthMock.mockReturnValue({
      token: null,
      loading: true,
    });

    render(
      <MemoryRouter initialEntries={['/hosts']}>
        <Routes>
          <Route path="/" element={<ProtectedRoute />}>
            <Route path="/hosts" element={<div>Hosts view</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Loading session...')).toBeInTheDocument();
  });

  it('redirects unauthenticated users to /login', () => {
    useAuthMock.mockReturnValue({
      token: null,
      loading: false,
    });

    render(
      <MemoryRouter initialEntries={['/hosts']}>
        <Routes>
          <Route path="/login" element={<div>Login view</div>} />
          <Route path="/" element={<ProtectedRoute />}>
            <Route path="/hosts" element={<div>Hosts view</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Login view')).toBeInTheDocument();
  });

  it('renders nested routes when token exists', () => {
    useAuthMock.mockReturnValue({
      token: 'token-123',
      loading: false,
    });

    render(
      <MemoryRouter initialEntries={['/hosts']}>
        <Routes>
          <Route path="/login" element={<div>Login view</div>} />
          <Route path="/" element={<ProtectedRoute />}>
            <Route path="/hosts" element={<div>Hosts view</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Hosts view')).toBeInTheDocument();
  });
});
