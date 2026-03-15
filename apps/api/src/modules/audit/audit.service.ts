/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements audit service business logic for the service layer.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type AuditInput = {
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
};

@Injectable()
/**
 * Implements the audit service class.
 */
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Handles write.
   */
  async write(event: AuditInput) {
    return this.prisma.auditEvent.create({
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
  }
}
