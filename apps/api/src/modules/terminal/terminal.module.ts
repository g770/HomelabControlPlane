/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the terminal module providers and dependencies.
 */
import { Module } from '@nestjs/common';
import { McpModule } from '../mcp/mcp.module';
import { TerminalController } from './terminal.controller';
import { TerminalService } from './terminal.service';

@Module({
  imports: [McpModule],
  controllers: [TerminalController],
  providers: [TerminalService],
})
/**
 * Implements the terminal module class.
 */
export class TerminalModule {}
