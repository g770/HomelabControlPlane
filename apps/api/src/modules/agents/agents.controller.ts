/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes agents controller request handling for the API service.
 */
import { Body, Controller, Delete, Get, Headers, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AgentsService } from './agents.service';
import { deleteAgentSchema } from './agents.schemas';

@Controller()
/**
 * Implements the agents controller class.
 */
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Post('enrollment-tokens')
  createEnrollmentToken(
    @Body() body: { expiresHours?: number },
    @CurrentUser() user: { sub: string },
  ) {
    return this.agentsService.createEnrollmentToken(user.sub, body.expiresHours ?? 24);
  }

  @Get('enrollment-tokens')
  /**
   * Handles list enrollment tokens.
   */
  listEnrollmentTokens() {
    return this.agentsService.listEnrollmentTokens();
  }

  @Post('enrollment-tokens/:tokenId/revoke')
  revokeEnrollmentToken(@Param('tokenId') tokenId: string, @CurrentUser() user: { sub: string }) {
    return this.agentsService.revokeEnrollmentToken(tokenId, user.sub);
  }

  @Public()
  @Post('agents/enroll')
  /**
   * Handles enroll.
   */
  enroll(@Body() body: unknown) {
    return this.agentsService.enroll(body);
  }

  @Public()
  @Post('agents/:agentId/heartbeat')
  heartbeat(
    @Param('agentId') agentId: string,
    @Headers('authorization') authorization: string,
    @Body() body: unknown,
  ) {
    const token = this.agentsService.parseBearerToken(authorization);
    return this.agentsService.heartbeat(agentId, token, body);
  }

  @Public()
  @Post('agents/:agentId/facts')
  facts(
    @Param('agentId') agentId: string,
    @Headers('authorization') authorization: string,
    @Body() body: unknown,
  ) {
    const token = this.agentsService.parseBearerToken(authorization);
    return this.agentsService.facts(agentId, token, body);
  }

  @Public()
  @Post('agents/:agentId/inventory')
  inventory(
    @Param('agentId') agentId: string,
    @Headers('authorization') authorization: string,
    @Body() body: unknown,
  ) {
    const token = this.agentsService.parseBearerToken(authorization);
    return this.agentsService.inventory(agentId, token, body);
  }

  @Public()
  @Post('agents/:agentId/events')
  events(
    @Param('agentId') agentId: string,
    @Headers('authorization') authorization: string,
    @Body() body: unknown,
  ) {
    const token = this.agentsService.parseBearerToken(authorization);
    return this.agentsService.ingestEvents(agentId, token, body);
  }

  @Get('agents')
  /**
   * Handles list agents.
   */
  listAgents() {
    return this.agentsService.listAgents();
  }

  @Get('agents/:agentId')
  /**
   * Gets agent.
   */
  getAgent(@Param('agentId') agentId: string) {
    return this.agentsService.getAgent(agentId);
  }

  @Post('agents/:agentId/revoke')
  /**
   * Handles revoke.
   */
  revoke(@Param('agentId') agentId: string, @CurrentUser() user: { sub: string }) {
    return this.agentsService.revoke(agentId, user.sub);
  }

  @Delete('agents/:agentId')
  deleteAgent(
    @Param('agentId') agentId: string,
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(deleteAgentSchema)) _deleteBody: { confirm: true },
  ) {
    void _deleteBody;
    return this.agentsService.deleteRevoked(agentId, user.sub);
  }
}
