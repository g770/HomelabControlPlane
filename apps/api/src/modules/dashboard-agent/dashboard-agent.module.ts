/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the dashboard agent module providers and dependencies.
 */
import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { McpModule } from '../mcp/mcp.module';
import { DashboardAgentController } from './dashboard-agent.controller';
import { DashboardAgentMcpService } from './dashboard-agent.mcp.service';
import { DashboardAgentScheduler } from './dashboard-agent.scheduler';
import { DashboardAgentService } from './dashboard-agent.service';

@Module({
  imports: [AiModule, McpModule],
  controllers: [DashboardAgentController],
  providers: [DashboardAgentService, DashboardAgentScheduler, DashboardAgentMcpService],
  exports: [DashboardAgentService],
})
/**
 * Implements the dashboard agent module class.
 */
export class DashboardAgentModule {}
