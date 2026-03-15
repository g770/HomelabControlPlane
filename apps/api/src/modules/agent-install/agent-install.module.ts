/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the agent install module providers and dependencies.
 */
import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AgentInstallController } from './agent-install.controller';
import { AgentInstallService } from './agent-install.service';

@Module({
  imports: [AgentsModule],
  controllers: [AgentInstallController],
  providers: [AgentInstallService],
  exports: [AgentInstallService],
})
/**
 * Implements the agent install module class.
 */
export class AgentInstallModule {}
