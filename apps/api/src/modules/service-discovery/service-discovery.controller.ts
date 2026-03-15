/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes service discovery controller request handling for the API service.
 */
import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  serviceDiscoveryConfigUpdateSchema,
  serviceDiscoveryRunDeleteSchema,
  serviceDiscoveryRunRequestSchema,
  type ServiceDiscoveryConfigUpdate,
  type ServiceDiscoveryRunDelete,
  type ServiceDiscoveryRunRequest,
} from '@homelab/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ServiceDiscoveryService } from './service-discovery.service';

@Controller('discovery/services')
/**
 * Implements the service discovery controller class.
 */
export class ServiceDiscoveryController {
  constructor(
    @Inject(ServiceDiscoveryService)
    private readonly serviceDiscoveryService: ServiceDiscoveryService,
  ) {}

  @Post('run')
  runNow(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(serviceDiscoveryRunRequestSchema)) body: ServiceDiscoveryRunRequest,
  ) {
    return this.serviceDiscoveryService.triggerManualRun(user.sub, {
      hostId: body.hostId,
    });
  }

  @Get('config')
  /**
   * Handles config.
   */
  config() {
    return this.serviceDiscoveryService.getConfig();
  }

  @Put('config')
  updateConfig(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(serviceDiscoveryConfigUpdateSchema))
    body: ServiceDiscoveryConfigUpdate,
  ) {
    return this.serviceDiscoveryService.updateConfig(user.sub, body.config);
  }

  @Get('runs')
  /**
   * Handles list runs.
   */
  listRuns(@Query('limit') limit?: string) {
    const parsedLimit = limit === undefined ? undefined : Number.parseInt(limit, 10);
    return this.serviceDiscoveryService.listRuns(parsedLimit);
  }

  @Delete('runs/:runId')
  deleteRun(
    @CurrentUser() user: { sub: string },
    @Param('runId') runId: string,
    @Body(new ZodValidationPipe(serviceDiscoveryRunDeleteSchema)) body: ServiceDiscoveryRunDelete,
  ) {
    void body;
    return this.serviceDiscoveryService.deleteRun(runId, user.sub);
  }

  @Get('catalog')
  /**
   * Handles catalog.
   */
  catalog() {
    return this.serviceDiscoveryService.getEffectiveCatalog();
  }
}
