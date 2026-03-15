/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the queue test behavior.
 */
import { describe, expect, it, vi } from 'vitest';
import { enqueueRepeatJobs } from '../src/queue';

describe('enqueueRepeatJobs', () => {
  it('adds each recurring worker job with fixed job ids', async () => {
    const add = vi.fn().mockResolvedValue(undefined);

    await enqueueRepeatJobs({ add } as never);

    expect(add).toHaveBeenCalledTimes(3);
    expect(add.mock.calls.map((call) => call[0])).toEqual([
      'checks.run',
      'integrations.sync',
      'cleanup',
    ]);
    expect(add).toHaveBeenNthCalledWith(
      1,
      'checks.run',
      {},
      expect.objectContaining({
        jobId: 'checks.run',
      }),
    );
  });
});
