/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the queue logic for the repository.
 */
import type { Queue } from 'bullmq';

/**
 * Implements queue name.
 */
export const queueName = 'control-plane-jobs';

type RepeatQueue = Pick<Queue, 'add'>;

// Schedules idempotent repeat jobs; fixed jobIds prevent duplicate schedules.
export async function enqueueRepeatJobs(queue: RepeatQueue) {
  await queue.add(
    'checks.run',
    {},
    {
      repeat: { every: 30_000 },
      removeOnComplete: true,
      removeOnFail: 100,
      jobId: 'checks.run',
    },
  );

  await queue.add(
    'integrations.sync',
    {},
    {
      repeat: { every: 300_000 },
      removeOnComplete: true,
      removeOnFail: 100,
      jobId: 'integrations.sync',
    },
  );

  await queue.add(
    'cleanup',
    {},
    {
      repeat: { every: 3_600_000 },
      removeOnComplete: true,
      removeOnFail: 100,
      jobId: 'cleanup',
    },
  );
}
