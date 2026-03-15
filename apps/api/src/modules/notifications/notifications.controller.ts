/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes notifications controller request handling for the API service.
 */
import { Body, Controller, Get, NotFoundException, Post } from '@nestjs/common';
import { notificationRouteCreateSchema, type NotificationRouteCreate } from '@homelab/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from './notifications.service';
import { SecurityService } from '../common/security.service';

@Controller()
/**
 * Implements the notifications controller class.
 */
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly securityService: SecurityService,
    private readonly auditService: AuditService,
  ) {}

  @Get('notification-routes')
  /**
   * Handles list routes.
   */
  async listRoutes() {
    const routes = await this.prisma.notificationRoute.findMany({ orderBy: { createdAt: 'desc' } });
    return routes.map((route) => ({
      id: route.id,
      name: route.name,
      type: route.type,
      enabled: route.enabled,
      createdAt: route.createdAt,
      updatedAt: route.updatedAt,
    }));
  }

  @Post('notification-routes')
  async createRoute(
    @Body(new ZodValidationPipe(notificationRouteCreateSchema)) body: NotificationRouteCreate,
    @CurrentUser() user: { sub: string },
  ) {
    const encrypted = this.securityService.encryptJson(body.config);
    const route = await this.prisma.notificationRoute.create({
      data: {
        name: body.name,
        type: body.type,
        configEncrypted: encrypted,
        enabled: body.enabled ?? true,
      },
    });

    await this.auditService.write({
      actorUserId: user.sub,
      action: 'notification_route.create',
      targetType: 'notification_route',
      targetId: route.id,
      success: true,
    });

    return {
      id: route.id,
      name: route.name,
      type: route.type,
      enabled: route.enabled,
      createdAt: route.createdAt,
      updatedAt: route.updatedAt,
    };
  }

  @Post('notifications/test')
  async testRoute(@Body() body: { routeId: string }, @CurrentUser() user: { sub: string }) {
    const route = await this.prisma.notificationRoute.findUnique({ where: { id: body.routeId } });
    if (!route) {
      throw new NotFoundException('Route not found');
    }

    await this.notificationsService.testRoute(route);

    await this.auditService.write({
      actorUserId: user.sub,
      action: 'notification_route.test',
      targetType: 'notification_route',
      targetId: route.id,
      success: true,
    });

    return { ok: true };
  }
}
