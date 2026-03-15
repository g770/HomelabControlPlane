/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the main logic for the repository.
 */
import { Queue, Worker } from 'bullmq';
import { createJobProcessor } from './dispatcher';
import type { WorkerPrismaClient } from './prisma-contract';
import { enqueueRepeatJobs, queueName } from './queue';
import { workerRuntimeLogger } from './runtime-logger';

// Background worker responsible for recurring checks and integration
// synchronization into the control-plane database.
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const databaseUrl = process.env.DATABASE_URL;
const appMasterKey = process.env.APP_MASTER_KEY;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}
if (!appMasterKey) {
  throw new Error('APP_MASTER_KEY is required');
}

const prisma = createPrismaClient();
const queueConnection = { url: redisUrl };
const queue = new Queue(queueName, { connection: queueConnection });

// Starts queue worker and wires graceful shutdown hooks.
async function start() {
  await enqueueRepeatJobs(queue);

  const worker = new Worker(queueName, createJobProcessor({ prisma }), {
    connection: queueConnection,
  });

  worker.on('failed', (job, err) => {
    workerRuntimeLogger.error('Worker job failed', {
      jobName: job?.name ?? 'unknown',
      jobId: job?.id ?? null,
      reason: err.message,
    });
  });

  worker.on('completed', (job) => {
    workerRuntimeLogger.info('Worker job completed', {
      jobName: job.name,
      jobId: job.id ?? null,
    });
  });

  workerRuntimeLogger.info('Worker started', {
    queueName,
  });

  /**
   * Implements shutdown.
   */
  const shutdown = async () => {
    workerRuntimeLogger.info('Worker shutdown requested');
    await worker.close();
    await queue.close();
    await prisma.$disconnect();
    workerRuntimeLogger.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch(async (error) => {
  workerRuntimeLogger.error('Worker startup failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  await prisma.$disconnect();
  workerRuntimeLogger.close();
  process.exit(1);
});

type PrismaClientConstructor = new () => WorkerPrismaClient;

/**
 * Creates prisma client.
 */
function createPrismaClient() {
  const prismaModule = require('@prisma/client') as { PrismaClient: PrismaClientConstructor };
  return new prismaModule.PrismaClient();
}
