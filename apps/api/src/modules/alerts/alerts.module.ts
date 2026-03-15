/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the alerts module providers and dependencies.
 */
import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AlertsController } from './alerts.controller';
import { AlertsScheduler } from './alerts.scheduler';
import { AlertsService } from './alerts.service';

@Module({
  imports: [NotificationsModule, AiModule],
  controllers: [AlertsController],
  providers: [AlertsService, AlertsScheduler],
  exports: [AlertsService],
})
/**
 * Implements the alerts module class.
 */
export class AlertsModule {}
