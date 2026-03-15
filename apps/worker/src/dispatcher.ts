/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the dispatcher logic for the repository.
 */
import { processChecksJob, processCleanupJob, processIntegrationsJob } from './jobs';
import type { WorkerPrismaClient } from './prisma-contract';

type WorkerJob = {
  name: string;
};

type WorkerJobResult = {
  ok: boolean;
  job: string;
};

type JobProcessorDependencies = {
  prisma: WorkerPrismaClient;
};

/**
 * Creates job processor.
 */
export function createJobProcessor(dependencies: JobProcessorDependencies) {
  return async (job: WorkerJob): Promise<WorkerJobResult> => {
    if (job.name === 'checks.run') {
      await processChecksJob(dependencies.prisma);
      return { ok: true, job: job.name };
    }
    if (job.name === 'integrations.sync') {
      await processIntegrationsJob(dependencies.prisma);
      return { ok: true, job: job.name };
    }
    if (job.name === 'cleanup') {
      await processCleanupJob(dependencies.prisma);
      return { ok: true, job: job.name };
    }
    return { ok: false, job: job.name };
  };
}
