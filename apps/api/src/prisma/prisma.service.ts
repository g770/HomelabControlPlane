/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements prisma service business logic for the service layer.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
/**
 * Implements the prisma service class.
 */
export class PrismaService extends PrismaClient implements OnModuleInit {
  /**
   * Handles on module init.
   */
  async onModuleInit() {
    await this.$connect();
  }
}
