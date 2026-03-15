/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the reconcile host duplicates logic for the repository.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  extractResolvedPrimaryIp,
  findHostsByIdentity,
  normalizePrimaryIp,
  reconcileHostGroup,
} from '../src/modules/common/host-identity';

const prisma = new PrismaClient();

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
 * Implements backfill resolved primary ips.
 */
async function backfillResolvedPrimaryIps() {
  const hosts = await prisma.host.findMany({
    select: {
      id: true,
      facts: {
        orderBy: {
          createdAt: 'desc',
        },
        take: 1,
        select: {
          snapshot: true,
        },
      },
    },
  });

  return hosts.reduce((count, host) => {
    return extractResolvedPrimaryIp(host.facts[0]?.snapshot) ? count + 1 : count;
  }, 0);
}

/**
 * Implements reconcile duplicate groups.
 */
async function reconcileDuplicateGroups() {
  const rows = await prisma.host.findMany({
    select: {
      facts: {
        orderBy: {
          createdAt: 'desc',
        },
        take: 1,
        select: {
          snapshot: true,
        },
      },
    },
  });
  const primaryIps = Array.from(
    new Set(
      rows
        .map((row) => normalizePrimaryIp(extractResolvedPrimaryIp(row.facts[0]?.snapshot)))
        .filter((value): value is string => Boolean(value)),
    ),
  );

  let mergedGroups = 0;
  let skippedGroups = 0;

  for (const primaryIp of primaryIps) {
    const matches = await findHostsByIdentity(prisma, { primaryIp });
    if (matches.length <= 1) {
      continue;
    }

    const result = await reconcileHostGroup(prisma, auditWriter, matches, {
      primaryIp,
    });
    if (result.skippedReason) {
      skippedGroups += 1;
      continue;
    }
    if (result.mergedHostIds.length > 0) {
      mergedGroups += 1;
    }
  }

  return { mergedGroups, skippedGroups };
}

/**
 * Implements main.
 */
async function main() {
  const hostsWithPrimaryIp = await backfillResolvedPrimaryIps();
  const { mergedGroups, skippedGroups } = await reconcileDuplicateGroups();

  console.log(
    JSON.stringify(
      {
        ok: true,
        hostsWithPrimaryIp,
        mergedGroups,
        skippedGroups,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
