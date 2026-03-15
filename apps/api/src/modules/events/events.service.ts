/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements events service business logic for the service layer.
 */
import { Injectable } from '@nestjs/common';
import { EventSeverity } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { Subject } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';

type EventInput = {
  type: string;
  message: string;
  severity?: EventSeverity;
  hostId?: string;
  serviceId?: string;
  checkId?: string;
  payload?: Prisma.InputJsonValue;
};

@Injectable()
/**
 * Implements the events service class.
 */
export class EventsService {
  private readonly stream$ = new Subject<{ id: string; type: string; message: string }>();

  /**
   * Creates the instance and stores the dependencies required by this type.
   */
  constructor(private readonly prisma: PrismaService) {}

  get stream() {
    return this.stream$.asObservable();
  }

  /**
   * Handles list.
   */
  async list(limit = 100) {
    return this.prisma.event.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  /**
   * Handles emit.
   */
  async emit(input: EventInput) {
    const created = await this.prisma.event.create({
      data: {
        type: input.type,
        message: input.message,
        severity: input.severity ?? EventSeverity.INFO,
        hostId: input.hostId,
        serviceId: input.serviceId,
        checkId: input.checkId,
        payload: input.payload,
      },
    });

    this.stream$.next({
      id: created.id,
      type: created.type,
      message: created.message,
    });

    return created;
  }
}
