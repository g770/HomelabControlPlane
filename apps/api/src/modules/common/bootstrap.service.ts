/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements bootstrap service business logic for the service layer.
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LOCAL_ADMIN_DISPLAY_NAME, LOCAL_ADMIN_EMAIL } from '../auth/admin-account';

@Injectable()
/**
 * Implements the bootstrap service class.
 */
export class BootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Implements the on module init workflow for this file.
   */
  async onModuleInit(): Promise<void> {
    await this.ensureAdminAccount();
  }

  /**
   * Handles ensure admin account.
   */
  private async ensureAdminAccount() {
    await this.prisma.user.upsert({
      where: { email: LOCAL_ADMIN_EMAIL },
      update: {
        active: true,
        displayName: LOCAL_ADMIN_DISPLAY_NAME,
      },
      create: {
        email: LOCAL_ADMIN_EMAIL,
        passwordHash: null,
        displayName: LOCAL_ADMIN_DISPLAY_NAME,
        active: true,
      },
    });

    this.logger.log('Admin account bootstrap record ensured');
  }
}
