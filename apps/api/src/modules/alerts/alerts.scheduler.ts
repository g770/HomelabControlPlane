/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module schedules the alerts scheduler background work for the service.
 */
import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AlertsService } from './alerts.service';

@Injectable()
/**
 * Implements the alerts scheduler class.
 */
export class AlertsScheduler {
  constructor(private readonly alertsService: AlertsService) {}

  @Interval(60_000)
  /**
   * Handles tick.
   */
  async tick() {
    await this.alertsService.triggerScheduledRunIfDue();
  }
}
