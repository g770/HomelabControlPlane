/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the prisma contract logic for the repository.
 */
type WorkerCheckRecord = {
  id: string;
  hostId: string | null;
  name: string;
  type: string;
  target: string;
  timeoutMs: number;
  expectedStatus: number | null;
  keyword: string | null;
};

type WorkerIntegrationRecord = {
  id: string;
  name: string;
  type: 'PROXMOX';
  config: unknown;
  credential: {
    encryptedBlob: string;
  } | null;
};

/**
 * Describes the worker prisma client shape.
 */
export type WorkerPrismaClient = {
  check: {
    findMany(args: unknown): Promise<WorkerCheckRecord[]>;
  };
  checkResult: {
    create(args: unknown): Promise<unknown>;
    deleteMany(args: unknown): Promise<unknown>;
  };
  event: {
    create(args: unknown): Promise<unknown>;
    deleteMany(args: unknown): Promise<unknown>;
  };
  alertRule: {
    findMany(args: unknown): Promise<unknown>;
  };
  alertEvent: {
    upsert(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
  host: {
    findMany(args: unknown): Promise<unknown>;
    /**
     * Implements the upsert workflow for this file.
     */
    upsert(args: unknown): Promise<{ id: string; hostname: string }>;
  };
  service: {
    /**
     * Implements the upsert workflow for this file.
     */
    upsert(args: unknown): Promise<{ id: string; name: string }>;
  };
  serviceInstance: {
    upsert(args: unknown): Promise<unknown>;
  };
  integration: {
    findMany(args: unknown): Promise<WorkerIntegrationRecord[]>;
    /**
     * Finds unique for the surrounding workflow.
     */
    findUnique(args: unknown): Promise<{ id: string; enabled: boolean } | null>;
    update(args: unknown): Promise<unknown>;
  };
  hostFact: {
    deleteMany(args: unknown): Promise<unknown>;
  };
  aiMessage: {
    deleteMany(args: unknown): Promise<unknown>;
  };
  $disconnect(): Promise<void>;
};
