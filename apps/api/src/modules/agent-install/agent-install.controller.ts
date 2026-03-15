/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes agent install controller request handling for the API service.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  MessageEvent,
  Param,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import {
  agentInstallApproveSchema,
  agentInstallDenySchema,
  agentInstallStatusSchema,
  createAgentInstallRequestSchema,
  launchAgentInstallRequestSchema,
  agentInstallUninstallFromAgentSchema,
  type AgentInstallApprove,
  type AgentInstallUninstallFromAgent,
  type AgentInstallDeny,
  type CreateAgentInstallRequest,
  type LaunchAgentInstallRequest,
} from '@homelab/shared';
import { Observable } from 'rxjs';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AgentInstallService } from './agent-install.service';

@Controller('agent-installs')
/**
 * Implements the agent install controller class.
 */
export class AgentInstallController {
  constructor(private readonly agentInstallService: AgentInstallService) {}

  @Get('binaries')
  /**
   * Handles binaries.
   */
  binaries() {
    return this.agentInstallService.binaryManifest();
  }

  @Post('requests')
  createRequest(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(createAgentInstallRequestSchema)) body: CreateAgentInstallRequest,
  ) {
    return this.agentInstallService.createRequest(user.sub, body);
  }

  @Get('requests')
  /**
   * Handles list requests.
   */
  listRequests(@Query('status') status?: string) {
    const parsedStatus = status ? agentInstallStatusSchema.safeParse(status) : null;
    return this.agentInstallService.listRequests(
      parsedStatus?.success ? parsedStatus.data : undefined,
    );
  }

  @Get('requests/:requestId')
  /**
   * Gets request.
   */
  getRequest(@Param('requestId') requestId: string) {
    return this.agentInstallService.getRequest(requestId);
  }

  @Get('requests/:requestId/logs')
  /**
   * Handles list logs.
   */
  listLogs(@Param('requestId') requestId: string, @Query('limit') limit?: string) {
    const parsedLimit = limit === undefined ? undefined : Number.parseInt(limit, 10);
    return this.agentInstallService.listLogs(requestId, parsedLimit);
  }

  @Sse('requests/:requestId/stream')
  streamRequest(@Param('requestId') requestId: string): Observable<MessageEvent> {
    return this.agentInstallService.streamRequest(requestId);
  }

  @Post('requests/:requestId/approve')
  approveRequest(
    @CurrentUser() user: { sub: string },
    @Param('requestId') requestId: string,
    @Body(new ZodValidationPipe(agentInstallApproveSchema)) body: AgentInstallApprove,
  ) {
    return this.agentInstallService.approveRequest(requestId, user.sub, body);
  }

  @Post('requests/:requestId/deny')
  denyRequest(
    @CurrentUser() user: { sub: string },
    @Param('requestId') requestId: string,
    @Body(new ZodValidationPipe(agentInstallDenySchema)) body: AgentInstallDeny,
  ) {
    return this.agentInstallService.denyRequest(requestId, user.sub, body);
  }

  @Post('requests/:requestId/launch')
  launchRequest(
    @CurrentUser() user: { sub: string },
    @Param('requestId') requestId: string,
    @Body(new ZodValidationPipe(launchAgentInstallRequestSchema)) body: LaunchAgentInstallRequest,
  ) {
    return this.agentInstallService.launchRequest(requestId, user.sub, body);
  }

  @Post('requests/:requestId/cancel')
  cancelRequest(
    @CurrentUser() user: { sub: string },
    @Param('requestId') requestId: string,
    @Body(new ZodValidationPipe(agentInstallApproveSchema)) body: AgentInstallApprove,
  ) {
    return this.agentInstallService.cancelRequest(requestId, user.sub, body);
  }

  @Delete('requests/:requestId')
  deleteRequest(
    @CurrentUser() user: { sub: string },
    @Param('requestId') requestId: string,
    @Body(new ZodValidationPipe(agentInstallApproveSchema)) body: AgentInstallApprove,
  ) {
    return this.agentInstallService.deleteRequest(requestId, user.sub, body);
  }

  @Post('requests/:requestId/create-rollback')
  createRollback(
    @CurrentUser() user: { sub: string },
    @Param('requestId') requestId: string,
    @Body(new ZodValidationPipe(agentInstallApproveSchema)) body: AgentInstallApprove,
  ) {
    return this.agentInstallService.createRollbackRequest(requestId, user.sub, body);
  }

  @Post('agents/:agentId/uninstall')
  uninstallFromAgent(
    @CurrentUser() user: { sub: string },
    @Param('agentId') agentId: string,
    @Body(new ZodValidationPipe(agentInstallUninstallFromAgentSchema))
    body: AgentInstallUninstallFromAgent,
  ) {
    return this.agentInstallService.createUninstallRequestFromAgent(agentId, user.sub, body);
  }
}
