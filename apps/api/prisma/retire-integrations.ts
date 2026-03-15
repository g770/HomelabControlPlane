/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the retire integrations logic for the repository.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { deleteIntegrationWithAudit } from '../src/modules/integrations/integration-cleanup';

const prisma = new PrismaClient();

type RetiredIntegrationRow = {
  id: string;
  name: string;
  type: string;
};

const RETIRED_TYPES = ['UNIFI', 'SYNOLOGY'] as const;

const auditWriter = {
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
  }) {
    return prisma.auditEvent.create({
      data: {
        actorUserId: event.actorUserId,
        actorAgentId: event.actorAgentId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        paramsJson: event.paramsJson,
        resultJson: event.resultJson,
        success: event.success,
        ip: event.ip,
        userAgent: event.userAgent,
      },
    });
  },
};

/**
 * Implements find retired integrations.
 */
async function findRetiredIntegrations() {
  return prisma.$queryRaw<RetiredIntegrationRow[]>`
    SELECT "id", "name", "type"::text AS "type"
    FROM "Integration"
    WHERE "type"::text IN ('UNIFI', 'SYNOLOGY')
    ORDER BY "createdAt" ASC
  `;
}

/**
 * Implements main.
 */
async function main() {
  const integrations = await findRetiredIntegrations();
  const retired: Array<{
    id: string;
    name: string;
    type: string;
    deletedServiceCount: number;
    deletedServiceInstanceCount: number;
    deletedHostCount: number;
  }> = [];

  for (const integration of integrations) {
    const result = await deleteIntegrationWithAudit(prisma, auditWriter, {
      integrationId: integration.id,
      integrationType: integration.type,
      action: 'integration.retire',
      paramsJson: {
        integrationName: integration.name,
        retiredType: integration.type,
        retiredTypes: [...RETIRED_TYPES],
      } as Prisma.InputJsonValue,
    });

    retired.push({
      id: integration.id,
      name: integration.name,
      type: integration.type,
      deletedServiceCount: result.deletedServiceCount,
      deletedServiceInstanceCount: result.deletedServiceInstanceCount,
      deletedHostCount: result.deletedHostCount,
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        retiredCount: retired.length,
        retired,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error('[prisma] Failed to retire legacy integrations.', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
