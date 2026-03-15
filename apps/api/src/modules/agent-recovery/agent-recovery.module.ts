/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the agent recovery module providers and dependencies.
 */
import { Module } from '@nestjs/common';
import { AgentRecoveryController } from './agent-recovery.controller';
import { AgentRecoveryService } from './agent-recovery.service';

@Module({
  controllers: [AgentRecoveryController],
  providers: [AgentRecoveryService],
  exports: [AgentRecoveryService],
})
/**
 * Implements the agent recovery module class.
 */
export class AgentRecoveryModule {}
