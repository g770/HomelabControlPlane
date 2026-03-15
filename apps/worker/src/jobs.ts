/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the jobs logic for the repository.
 */
import { decryptJson, syncIntegrationRecords, type IntegrationTypeValue } from './integrations';
import type { WorkerPrismaClient } from './prisma-contract';
import {
  runHttpCheck,
  runIcmpCheck,
  runTcpCheck,
  type CheckResultStatusValue,
  type HttpCheckInput,
  type IcmpCheckInput,
  type ProbeResult,
  type TcpCheckInput,
} from './probes';

type CheckTypeValue = 'HTTP' | 'TCP' | 'ICMP';
type EventSeverityValue = 'INFO' | 'WARN' | 'ERROR';

type CheckRecord = {
  id: string;
  hostId: string | null;
  name: string;
  type: string;
  target: string;
  timeoutMs: number;
  expectedStatus: number | null;
  keyword: string | null;
};

type IntegrationRecord = {
  id: string;
  name: string;
  type: IntegrationTypeValue;
  config: unknown;
  credential: {
    encryptedBlob: string;
  } | null;
};

type IntegrationJobDependencies = {
  decrypt: typeof decryptJson;
  sync: typeof syncIntegrationRecords;
  masterKey: string;
  now: () => Date;
};

type IntegrationStatusData = {
  lastSyncAt: Date;
  lastStatus: 'ok' | 'error';
  lastError: string | null;
};

/**
 * Implements resolve master key.
 */
function resolveMasterKey(override?: string): string {
  const masterKey = override?.trim() || process.env.APP_MASTER_KEY?.trim();
  if (!masterKey) {
    throw new Error('APP_MASTER_KEY is required');
  }

  return masterKey;
}

/**
 * Builds default integration dependencies.
 */
function buildDefaultIntegrationDependencies(
  masterKeyOverride?: string,
): IntegrationJobDependencies {
  return {
    decrypt: decryptJson,
    sync: syncIntegrationRecords,
    masterKey: resolveMasterKey(masterKeyOverride),
    now: () => new Date(),
  };
}

/**
 * Describes the check probe dependencies shape.
 */
export type CheckProbeDependencies = {
  runHttpCheck: (check: HttpCheckInput) => Promise<ProbeResult & { httpStatus?: number | null }>;
  runTcpCheck: (check: TcpCheckInput) => Promise<ProbeResult>;
  runIcmpCheck: (check: IcmpCheckInput) => Promise<ProbeResult>;
};

const defaultCheckProbeDependencies: CheckProbeDependencies = {
  runHttpCheck,
  runTcpCheck,
  runIcmpCheck,
};

// Executes enabled monitors and emits check-down events for failures.
export async function processChecksJob(
  prisma: WorkerPrismaClient,
  probes: CheckProbeDependencies = defaultCheckProbeDependencies,
) {
  const checks = (await prisma.check.findMany({ where: { enabled: true } })) as CheckRecord[];

  for (const check of checks) {
    let result: ProbeResult & { httpStatus?: number | null };
    if ((check.type as CheckTypeValue) === 'HTTP') {
      result = await probes.runHttpCheck(check);
    } else if ((check.type as CheckTypeValue) === 'TCP') {
      result = await probes.runTcpCheck(check);
    } else {
      result = await probes.runIcmpCheck(check);
    }

    await prisma.checkResult.create({
      data: {
        checkId: check.id,
        status: result.status as CheckResultStatusValue,
        latencyMs: result.latencyMs,
        httpStatus: result.httpStatus ?? undefined,
        errorMessage: result.errorMessage ?? undefined,
      },
    });

    if (result.status === 'DOWN') {
      await prisma.event.create({
        data: {
          type: 'check.down',
          severity: 'ERROR' as EventSeverityValue,
          checkId: check.id,
          hostId: check.hostId,
          message: `Check ${check.name} is down`,
          payload: {
            target: check.target,
            reason: result.errorMessage,
          },
        },
      });
    }
  }
}

// Compatibility stub retained while alert evaluation is owned by the API scheduler.
export async function processAlertsJob(prisma: WorkerPrismaClient) {
  void prisma;
  return;
}

// Pulls external integrations and reconciles host/service/service_instance rows.
export async function processIntegrationsJob(
  prisma: WorkerPrismaClient,
  dependencies: Partial<IntegrationJobDependencies> = {},
) {
  const deps: IntegrationJobDependencies = {
    ...buildDefaultIntegrationDependencies(dependencies.masterKey),
    ...dependencies,
  };

  const integrations = (await prisma.integration.findMany({
    where: {
      enabled: true,
      type: 'PROXMOX',
    },
    include: { credential: true },
  })) as IntegrationRecord[];
  for (const integration of integrations) {
    const source = `${integration.type.toLowerCase()}:${integration.id}`;
    try {
      if (!integration.credential) {
        throw new Error('Missing encrypted credentials');
      }
      const credentials = deps.decrypt(deps.masterKey, integration.credential.encryptedBlob);
      const records = await deps.sync(
        integration.type,
        (integration.config ?? {}) as Record<string, unknown>,
        credentials,
      );

      if (!(await integrationIsEnabled(prisma, integration.id))) {
        continue;
      }

      for (const record of records) {
        const host = await prisma.host.upsert({
          where: { hostname: record.hostName },
          update: {
            status: record.status,
            tags: record.tags ?? [],
            lastSeenAt: deps.now(),
          },
          create: {
            hostname: record.hostName,
            status: record.status,
            tags: record.tags ?? [],
            lastSeenAt: deps.now(),
          },
        });

        const service = await prisma.service.upsert({
          where: {
            name_source: {
              name: record.serviceName,
              source,
            },
          },
          update: {
            status: record.status,
            tags: record.tags ?? [],
          },
          create: {
            name: record.serviceName,
            source,
            status: record.status,
            tags: record.tags ?? [],
          },
        });

        await prisma.serviceInstance.upsert({
          where: {
            serviceId_hostId_name: {
              serviceId: service.id,
              hostId: host.id,
              name: `${service.name}@${host.hostname}`,
            },
          },
          update: {
            status: record.status,
            lastSeenAt: deps.now(),
          },
          create: {
            serviceId: service.id,
            hostId: host.id,
            name: `${service.name}@${host.hostname}`,
            status: record.status,
            metadata: { integration: integration.type },
            lastSeenAt: deps.now(),
          },
        });
      }

      if (!(await integrationIsEnabled(prisma, integration.id))) {
        continue;
      }

      const updated = await updateIntegrationStatus(prisma, integration.id, {
        lastSyncAt: deps.now(),
        lastStatus: 'ok',
        lastError: null,
      });
      if (!updated) {
        continue;
      }

      await prisma.event.create({
        data: {
          type: 'integration.sync',
          message: `Integration ${integration.name} synced ${records.length} records`,
          payload: {
            integrationId: integration.id,
            count: records.length,
          },
        },
      });
    } catch (error) {
      await updateIntegrationStatus(prisma, integration.id, {
        lastSyncAt: deps.now(),
        lastStatus: 'error',
        lastError: error instanceof Error ? error.message : 'sync failure',
      });
    }
  }
}

// Applies retention windows to high-volume telemetry/event tables.
export async function processCleanupJob(
  prisma: WorkerPrismaClient,
  retentionDays = Number(process.env.RETENTION_DAYS ?? 30),
) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  await Promise.all([
    prisma.checkResult.deleteMany({ where: { checkedAt: { lt: cutoff } } }),
    prisma.event.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.hostFact.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.aiMessage.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);
}

/**
 * Implements integration is enabled.
 */
async function integrationIsEnabled(prisma: WorkerPrismaClient, integrationId: string) {
  const current = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: {
      id: true,
      enabled: true,
    },
  });

  return current?.enabled === true;
}

/**
 * Implements update integration status.
 */
async function updateIntegrationStatus(
  prisma: WorkerPrismaClient,
  integrationId: string,
  data: IntegrationStatusData,
) {
  try {
    await prisma.integration.update({
      where: { id: integrationId },
      data,
    });
    return true;
  } catch (error) {
    if (isRecordNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Checks whether record not found error.
 */
function isRecordNotFoundError(error: unknown): error is { code: string } {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2025',
  );
}
