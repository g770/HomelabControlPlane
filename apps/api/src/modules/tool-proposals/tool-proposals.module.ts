/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the tool proposals module providers and dependencies.
 */
import { Module } from '@nestjs/common';
import { McpModule } from '../mcp/mcp.module';
import { ToolProposalsController } from './tool-proposals.controller';
import { ToolProposalsService } from './tool-proposals.service';

@Module({
  imports: [McpModule],
  controllers: [ToolProposalsController],
  providers: [ToolProposalsService],
  exports: [ToolProposalsService],
})
/**
 * Implements the tool proposals module class.
 */
export class ToolProposalsModule {}
