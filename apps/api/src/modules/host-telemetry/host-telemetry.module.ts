/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the host telemetry module providers and dependencies.
 */
import { Module } from '@nestjs/common';
import { HostTelemetryController } from './host-telemetry.controller';
import { HostTelemetryService } from './host-telemetry.service';
import { McpModule } from '../mcp/mcp.module';

@Module({
  imports: [McpModule],
  controllers: [HostTelemetryController],
  providers: [HostTelemetryService],
})
/**
 * Implements the host telemetry module class.
 */
export class HostTelemetryModule {}
