/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the agents module providers and dependencies.
 */
import { Module } from '@nestjs/common';
import { AgentRecoveryModule } from '../agent-recovery/agent-recovery.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [AgentRecoveryModule],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
/**
 * Implements the agents module class.
 */
export class AgentsModule {}
