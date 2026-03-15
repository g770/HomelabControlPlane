/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes checks controller request handling for the API service.
 */
import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { monitorParseRequestSchema, type MonitorParseRequest } from '@homelab/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ChecksService } from './checks.service';

// Monitor endpoints: CRUD, history, plus AI-assisted parse/suggestion routes.
@Controller('checks')
/**
 * Implements the checks controller class.
 */
export class ChecksController {
  constructor(private readonly checksService: ChecksService) {}

  @Get()
  /**
   * Handles list.
   */
  list() {
    return this.checksService.list();
  }

  @Post()
  /**
   * Creates create.
   */
  create(@CurrentUser() user: { sub: string }, @Body() body: unknown) {
    return this.checksService.create(user.sub, body);
  }

  @Post('ai/parse')
  parseMonitorDescription(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(monitorParseRequestSchema)) body: MonitorParseRequest,
  ) {
    return this.checksService.parseMonitorDescription(user.sub, body);
  }

  @Get('ai/suggestions')
  /**
   * Handles monitor suggestions.
   */
  monitorSuggestions(@CurrentUser() user: { sub: string }) {
    return this.checksService.suggestMonitors(user.sub);
  }

  @Get(':id')
  /**
   * Gets get.
   */
  get(@Param('id') id: string) {
    return this.checksService.get(id);
  }

  @Put(':id')
  /**
   * Handles update.
   */
  update(@Param('id') id: string, @CurrentUser() user: { sub: string }, @Body() body: unknown) {
    return this.checksService.update(id, user.sub, body);
  }

  @Delete(':id')
  /**
   * Handles remove.
   */
  remove(@Param('id') id: string, @CurrentUser() user: { sub: string }) {
    return this.checksService.remove(id, user.sub);
  }

  @Get(':id/history')
  /**
   * Handles history.
   */
  history(@Param('id') id: string, @Query('hours') hours?: string) {
    return this.checksService.history(id, hours ? Number(hours) : 24);
  }
}
