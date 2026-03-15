/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the integration cleanup logic for the repository.
 */
import type { Prisma } from '@prisma/client';

type AuditWriter = {
  write(event: {
    actorUserId?: string;
    actorAgentId?: string;
    action: string;
    targetType: string;
    targetId?: string;
    paramsJson?: Prisma.InputJsonValue;
    resultJson?: Prisma.InputJsonValue;
    success: boolean;
    ip?: string;
    userAgent?: string;
  }): Promise<unknown>;
};

type TransactionClient = Prisma.TransactionClient;
type TransactionRunner = {
  $transaction<T>(callback: (tx: TransactionClient) => Promise<T>): Promise<T>;
};

type CleanupHostRecord = {
  id: string;
  agent: { id: string } | null;
  serviceInstances: Array<{ id: string }>;
  checks: Array<{ id: string }>;
  agentInstallRequests: Array<{ id: string }>;
  facts: Array<{ id: string }>;
};

/**
 * Describes the integration cleanup result shape.
 */
export type IntegrationCleanupResult = {
  source: string;
  deletedServiceCount: number;
  deletedServiceInstanceCount: number;
  deletedHostCount: number;
};

type IntegrationCleanupInput = {
  integrationId: string;
  integrationType: string;
};

type DeleteIntegrationWithAuditInput = IntegrationCleanupInput & {
  action: string;
  actorUserId?: string;
  paramsJson?: Prisma.InputJsonValue;
};

/**
 * Implements delete integration with audit.
 */
export async function deleteIntegrationWithAudit(
  prisma: TransactionRunner,
  auditWriter: AuditWriter,
  input: DeleteIntegrationWithAuditInput,
) {
  const result = await prisma.$transaction((tx) => deleteIntegrationArtifacts(tx, input));

  await auditWriter.write({
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: 'integration',
    targetId: input.integrationId,
    paramsJson: input.paramsJson,
    resultJson: {
      source: result.source,
      deletedServiceCount: result.deletedServiceCount,
      deletedServiceInstanceCount: result.deletedServiceInstanceCount,
      deletedHostCount: result.deletedHostCount,
    } as Prisma.InputJsonValue,
    success: true,
  });

  return {
    ok: true as const,
    integrationId: input.integrationId,
    deletedServiceCount: result.deletedServiceCount,
    deletedServiceInstanceCount: result.deletedServiceInstanceCount,
    deletedHostCount: result.deletedHostCount,
  };
}

/**
 * Implements delete integration artifacts.
 */
export async function deleteIntegrationArtifacts(
  tx: TransactionClient,
  input: IntegrationCleanupInput,
): Promise<IntegrationCleanupResult> {
  const source = buildIntegrationSource(input.integrationType, input.integrationId);
  const services = await tx.service.findMany({
    where: { source },
    select: {
      id: true,
      instances: {
        select: {
          id: true,
          hostId: true,
        },
      },
    },
  });

  const deletedServiceCount = services.length;
  const deletedServiceInstanceCount = services.reduce(
    (count, service) => count + service.instances.length,
    0,
  );
  const candidateHostIds = Array.from(
    new Set(
      services
        .flatMap((service) => service.instances)
        .map((instance) => instance.hostId)
        .filter((hostId): hostId is string => typeof hostId === 'string'),
    ),
  );

  if (deletedServiceCount > 0) {
    await tx.service.deleteMany({
      where: { source },
    });
  }

  await tx.integration.delete({
    where: { id: input.integrationId },
  });

  let deletedHostCount = 0;
  for (const hostId of candidateHostIds) {
    const host = await tx.host.findUnique({
      where: { id: hostId },
      select: {
        id: true,
        agent: {
          select: {
            id: true,
          },
        },
        serviceInstances: {
          select: {
            id: true,
          },
          take: 1,
        },
        checks: {
          select: {
            id: true,
          },
          take: 1,
        },
        agentInstallRequests: {
          select: {
            id: true,
          },
          take: 1,
        },
        facts: {
          select: {
            id: true,
          },
          take: 1,
        },
      },
    });

    if (!host || !isDeleteEligibleHost(host)) {
      continue;
    }

    await tx.host.delete({
      where: { id: host.id },
    });
    deletedHostCount += 1;
  }

  return {
    source,
    deletedServiceCount,
    deletedServiceInstanceCount,
    deletedHostCount,
  };
}

/**
 * Builds integration source.
 */
export function buildIntegrationSource(type: string, integrationId: string) {
  return `${type.trim().toLowerCase()}:${integrationId}`;
}

/**
 * Checks whether delete eligible host.
 */
function isDeleteEligibleHost(host: CleanupHostRecord) {
  return (
    host.agent === null &&
    host.serviceInstances.length === 0 &&
    host.checks.length === 0 &&
    host.agentInstallRequests.length === 0 &&
    host.facts.length === 0
  );
}
