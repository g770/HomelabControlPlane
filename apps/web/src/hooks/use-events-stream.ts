/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This hook module coordinates the use events stream client-side behavior.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiBaseUrl } from '@/lib/utils';
import { getToken } from '@/lib/auth';

/**
 * Provides the use events stream hook.
 */
export function useEventsStream(enabled: boolean) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const token = getToken();
    if (!token) {
      return;
    }

    const url = `${apiBaseUrl}/api/events/stream`;
    const eventSource = new EventSource(`${url}?token=${encodeURIComponent(token)}`, {
      withCredentials: false,
    });

    /**
     * Handles any event.
     */
    const handleAnyEvent = () => {
      void queryClient.invalidateQueries({ queryKey: ['home-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['events'] });
      void queryClient.invalidateQueries({ queryKey: ['hosts'] });
      void queryClient.invalidateQueries({ queryKey: ['host'] });
      void queryClient.invalidateQueries({ queryKey: ['services'] });
      void queryClient.invalidateQueries({ queryKey: ['checks'] });
      void queryClient.invalidateQueries({ queryKey: ['alerts-active'] });
    };

    eventSource.onmessage = handleAnyEvent;
    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [enabled, queryClient]);
}
