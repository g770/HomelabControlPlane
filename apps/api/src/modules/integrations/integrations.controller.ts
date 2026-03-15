/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes integrations controller request handling for the API service.
 */
import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import {
  integrationActionRequestSchema,
  integrationDeleteSchema,
  integrationUpsertSchema,
  type IntegrationActionRequest,
  type IntegrationDelete,
  type IntegrationUpsert,
} from '@homelab/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { IntegrationsService } from './integrations.service';

@Controller('integrations')
/**
 * Implements the integrations controller class.
 */
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Get()
  /**
   * Handles list.
   */
  list() {
    return this.integrationsService.list();
  }

  @Post()
  createOrUpdate(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(integrationUpsertSchema)) body: IntegrationUpsert,
  ) {
    return this.integrationsService.createOrUpdate(user.sub, body);
  }

  @Post(':id/test')
  test(
    @CurrentUser() user: { sub: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(integrationActionRequestSchema)) _body: IntegrationActionRequest,
  ) {
    void _body;
    return this.integrationsService.test(user.sub, id);
  }

  @Post(':id/sync')
  sync(
    @CurrentUser() user: { sub: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(integrationActionRequestSchema)) _body: IntegrationActionRequest,
  ) {
    void _body;
    return this.integrationsService.sync(user.sub, id);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: { sub: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(integrationDeleteSchema)) _body: IntegrationDelete,
  ) {
    void _body;
    return this.integrationsService.remove(user.sub, id);
  }
}
