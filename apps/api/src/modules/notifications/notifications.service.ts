/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements notifications service business logic for the service layer.
 */
import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { SecurityService } from '../common/security.service';

@Injectable()
/**
 * Implements the notifications service class.
 */
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /**
   * Creates the instance and stores the dependencies required by this type.
   */
  constructor(private readonly securityService: SecurityService) {}

  async send(
    route: { type: NotificationType; configEncrypted: string; name: string },
    payload: Record<string, unknown>,
  ) {
    const config = this.securityService.decryptJson<Record<string, unknown>>(route.configEncrypted);

    switch (route.type) {
      case NotificationType.WEBHOOK:
        await this.sendWebhook(config, payload);
        break;
      case NotificationType.DISCORD:
        await this.sendWebhook(config, payload);
        break;
      default:
        this.logger.warn(`Unsupported notification type: ${route.type as string}`);
    }
  }

  /**
   * Implements the test route workflow for this file.
   */
  async testRoute(route: { type: NotificationType; configEncrypted: string; name: string }) {
    return this.send(route, {
      event: 'notification.test',
      message: 'Homelab Control Plane test notification',
      route: route.name,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handles send webhook.
   */
  private async sendWebhook(config: Record<string, unknown>, payload: Record<string, unknown>) {
    const url = config.url;
    if (typeof url !== 'string') {
      throw new Error('Webhook URL missing');
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const bearer = config.bearerToken;
    if (typeof bearer === 'string' && bearer.length > 0) {
      headers.Authorization = `Bearer ${bearer}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Webhook delivery failed (${response.status})`);
    }
  }
}
