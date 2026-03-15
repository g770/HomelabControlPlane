/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes host telemetry controller request handling for the API service.
 */
import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import {
  hostTelemetryConfigUpdateSchema,
  hostTelemetryRefreshRequestSchema,
  type HostTelemetryConfigUpdate,
  type HostTelemetryRefreshRequest,
} from '@homelab/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { HostTelemetryService } from './host-telemetry.service';

@Controller('hosts')
/**
 * Implements the host telemetry controller class.
 */
export class HostTelemetryController {
  constructor(private readonly hostTelemetryService: HostTelemetryService) {}

  @Get(':id/telemetry/config')
  /**
   * Gets config.
   */
  getConfig(@CurrentUser() user: { sub: string }, @Param('id') hostId: string) {
    return this.hostTelemetryService.getConfig(user.sub, hostId);
  }

  @Put(':id/telemetry/config')
  updateConfig(
    @CurrentUser() user: { sub: string },
    @Param('id') hostId: string,
    @Body(new ZodValidationPipe(hostTelemetryConfigUpdateSchema)) body: HostTelemetryConfigUpdate,
  ) {
    return this.hostTelemetryService.updateConfig(user.sub, hostId, body);
  }

  @Post(':id/telemetry/refresh')
  refreshNow(
    @CurrentUser() user: { sub: string },
    @Param('id') hostId: string,
    @Body(new ZodValidationPipe(hostTelemetryRefreshRequestSchema))
    body: HostTelemetryRefreshRequest,
  ) {
    return this.hostTelemetryService.refreshNow(user.sub, hostId, body);
  }
}
