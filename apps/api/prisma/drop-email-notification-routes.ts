/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the drop email notification routes logic for the repository.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Implements main.
 */
async function main() {
  const [tableState] = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'NotificationRoute'
    ) AS "exists"
  `;

  if (!tableState?.exists) {
    console.log(
      '[prisma] NotificationRoute table not present; skipping legacy email route cleanup.',
    );
    return;
  }

  const deleted = await prisma.$executeRawUnsafe(
    'DELETE FROM "NotificationRoute" WHERE "type"::text = \'EMAIL\'',
  );

  console.log(`[prisma] Removed ${deleted} legacy email notification route(s).`);
}

main()
  .catch((error) => {
    console.error('[prisma] Failed to remove legacy email notification routes.', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
