/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes dashboard agent controller request handling for the API service.
 */
import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  dashboardAgentConfigUpdateSchema,
  dashboardAgentRunDeleteSchema,
  dashboardAgentRunRequestSchema,
  type DashboardAgentConfigUpdate,
  type DashboardAgentRunDelete,
  type DashboardAgentRunRequest,
} from '@homelab/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DashboardAgentService } from './dashboard-agent.service';

@Controller('dashboard-agent')
/**
 * Implements the dashboard agent controller class.
 */
export class DashboardAgentController {
  constructor(
    @Inject(DashboardAgentService)
    private readonly dashboardAgentService: DashboardAgentService,
  ) {}

  @Get('status')
  /**
   * Handles status.
   */
  status() {
    return this.dashboardAgentService.getStatus();
  }

  @Get('runs')
  /**
   * Handles list runs.
   */
  listRuns(@Query('limit') limit?: string) {
    const parsedLimit = limit === undefined ? undefined : Number.parseInt(limit, 10);
    return this.dashboardAgentService.listRuns(parsedLimit, {
      includeDebug: true,
    });
  }

  @Get('runs/:id')
  /**
   * Gets run.
   */
  getRun(@Param('id') runId: string) {
    return this.dashboardAgentService.getRun(runId, {
      includeDebug: true,
    });
  }

  @Delete('runs/:id')
  deleteRun(
    @Param('id') runId: string,
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(dashboardAgentRunDeleteSchema)) _body: DashboardAgentRunDelete,
  ) {
    void _body;
    return this.dashboardAgentService.deleteRun(runId, user.sub);
  }

  @Get('highlights')
  /**
   * Handles highlights.
   */
  highlights() {
    return this.dashboardAgentService.getHighlights();
  }

  @Post('run')
  runNow(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(dashboardAgentRunRequestSchema)) _body: DashboardAgentRunRequest,
  ) {
    void _body;
    return this.dashboardAgentService.triggerManualRun(user.sub);
  }

  @Get('config')
  /**
   * Handles config.
   */
  config() {
    return this.dashboardAgentService.getConfig();
  }

  @Put('config')
  updateConfig(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(dashboardAgentConfigUpdateSchema)) body: DashboardAgentConfigUpdate,
  ) {
    return this.dashboardAgentService.updateConfig(user.sub, body.config);
  }
}
