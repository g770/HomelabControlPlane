/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the checks module providers and dependencies.
 */
import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ChecksController } from './checks.controller';
import { ChecksService } from './checks.service';

@Module({
  imports: [AiModule],
  controllers: [ChecksController],
  providers: [ChecksService],
  exports: [ChecksService],
})
/**
 * Implements the checks module class.
 */
export class ChecksModule {}
