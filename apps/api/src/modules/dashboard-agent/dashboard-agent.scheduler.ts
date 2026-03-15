/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module schedules the dashboard agent scheduler background work for the service.
 */
import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DashboardAgentService } from './dashboard-agent.service';

@Injectable()
/**
 * Implements the dashboard agent scheduler class.
 */
export class DashboardAgentScheduler {
  constructor(private readonly dashboardAgentService: DashboardAgentService) {}

  // Poll once per minute and execute when next due window is reached.
  @Interval(60_000)
  /**
   * Handles tick.
   */
  async tick() {
    await this.dashboardAgentService.triggerScheduledRunIfDue();
  }
}
