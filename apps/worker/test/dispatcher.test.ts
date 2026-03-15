/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the dispatcher test behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobProcessor } from '../src/dispatcher';
import * as jobs from '../src/jobs';
import type { WorkerPrismaClient } from '../src/prisma-contract';

describe('createJobProcessor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches checks.run to processChecksJob', async () => {
    const checksSpy = vi.spyOn(jobs, 'processChecksJob').mockResolvedValue(undefined);
    const processor = createJobProcessor({ prisma: {} as WorkerPrismaClient });

    const result = await processor({ name: 'checks.run' });

    expect(result).toEqual({ ok: true, job: 'checks.run' });
    expect(checksSpy).toHaveBeenCalledTimes(1);
  });

  it('dispatches integrations.sync to processIntegrationsJob', async () => {
    const integrationsSpy = vi.spyOn(jobs, 'processIntegrationsJob').mockResolvedValue(undefined);
    const processor = createJobProcessor({ prisma: {} as WorkerPrismaClient });

    const result = await processor({ name: 'integrations.sync' });

    expect(result).toEqual({ ok: true, job: 'integrations.sync' });
    expect(integrationsSpy).toHaveBeenCalledTimes(1);
  });

  it('dispatches cleanup to processCleanupJob', async () => {
    const cleanupSpy = vi.spyOn(jobs, 'processCleanupJob').mockResolvedValue(undefined);
    const processor = createJobProcessor({ prisma: {} as WorkerPrismaClient });

    const result = await processor({ name: 'cleanup' });

    expect(result).toEqual({ ok: true, job: 'cleanup' });
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('returns ok=false for unknown jobs', async () => {
    const processor = createJobProcessor({ prisma: {} as WorkerPrismaClient });

    const result = await processor({ name: 'unknown.job' });

    expect(result).toEqual({ ok: false, job: 'unknown.job' });
  });
});
