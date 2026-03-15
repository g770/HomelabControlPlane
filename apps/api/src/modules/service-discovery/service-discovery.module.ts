/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the service discovery module providers and dependencies.
 */
import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { McpModule } from '../mcp/mcp.module';
import { ServiceDiscoveryController } from './service-discovery.controller';
import { ServiceDiscoveryScheduler } from './service-discovery.scheduler';
import { ServiceDiscoveryService } from './service-discovery.service';

@Module({
  imports: [AiModule, McpModule],
  controllers: [ServiceDiscoveryController],
  providers: [ServiceDiscoveryService, ServiceDiscoveryScheduler],
  exports: [ServiceDiscoveryService],
})
/**
 * Implements the service discovery module class.
 */
export class ServiceDiscoveryModule {}
