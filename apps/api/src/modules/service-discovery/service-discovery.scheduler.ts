/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module schedules the service discovery scheduler background work for the service.
 */
import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ServiceDiscoveryService } from './service-discovery.service';

@Injectable()
/**
 * Implements the service discovery scheduler class.
 */
export class ServiceDiscoveryScheduler {
  constructor(private readonly serviceDiscoveryService: ServiceDiscoveryService) {}

  // Poll every minute and run when interval window is due.
  @Interval(60_000)
  /**
   * Handles tick.
   */
  async tick() {
    await this.serviceDiscoveryService.triggerScheduledRunIfDue();
  }
}
