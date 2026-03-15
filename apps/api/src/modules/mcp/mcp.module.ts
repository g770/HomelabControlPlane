/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the mcp module providers and dependencies.
 */
import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

@Module({
  controllers: [McpController],
  providers: [McpService],
  exports: [McpService],
})
/**
 * Implements the mcp module class.
 */
export class McpModule {}
