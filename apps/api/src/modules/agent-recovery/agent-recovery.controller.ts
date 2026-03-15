/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes agent recovery controller request handling for the API service.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  agentRecoveryClaimPollSchema,
  agentRecoveryClaimStatusSchema,
  approveAgentRecoveryClaimSchema,
  createAgentRecoveryChallengeSchema,
  denyAgentRecoveryClaimSchema,
  submitAgentRecoveryClaimSchema,
  type AgentRecoveryClaimPoll,
  type ApproveAgentRecoveryClaim,
  type DenyAgentRecoveryClaim,
  type SubmitAgentRecoveryClaim,
} from './agent-recovery.schemas';
import { AgentRecoveryService } from './agent-recovery.service';

@Controller()
/**
 * Implements the agent recovery controller class.
 */
export class AgentRecoveryController {
  constructor(private readonly agentRecoveryService: AgentRecoveryService) {}

  @Public()
  @Post('agents/reclaim/challenge')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createChallenge(
    @Body(new ZodValidationPipe(createAgentRecoveryChallengeSchema)) _body: Record<string, never>,
  ) {
    void _body;
    return this.agentRecoveryService.createChallenge();
  }

  @Public()
  @Post('agents/reclaim/claims')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  submitClaim(
    @Body(new ZodValidationPipe(submitAgentRecoveryClaimSchema)) body: SubmitAgentRecoveryClaim,
  ) {
    return this.agentRecoveryService.submitClaim(body);
  }

  @Public()
  @Post('agents/reclaim/claims/:claimId/status')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  claimStatus(
    @Param('claimId') claimId: string,
    @Body(new ZodValidationPipe(agentRecoveryClaimPollSchema)) body: AgentRecoveryClaimPoll,
  ) {
    return this.agentRecoveryService.status(claimId, body);
  }

  @Public()
  @Post('agents/reclaim/claims/:claimId/ack')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  ackClaim(
    @Param('claimId') claimId: string,
    @Body(new ZodValidationPipe(agentRecoveryClaimPollSchema)) body: AgentRecoveryClaimPoll,
  ) {
    return this.agentRecoveryService.ack(claimId, body);
  }

  @Get('agent-recovery/claims')
  /**
   * Handles list claims.
   */
  listClaims(@Query('status') status?: string) {
    const parsed = status ? agentRecoveryClaimStatusSchema.safeParse(status) : null;
    return this.agentRecoveryService.listClaims(parsed?.success ? parsed.data : undefined);
  }

  @Get('agent-recovery/summary')
  /**
   * Gets summary.
   */
  getSummary() {
    return this.agentRecoveryService.getSummary();
  }

  @Get('agent-recovery/claims/:claimId')
  /**
   * Gets claim.
   */
  getClaim(@Param('claimId') claimId: string) {
    return this.agentRecoveryService.getClaim(claimId);
  }

  @Post('agent-recovery/claims/:claimId/approve')
  approveClaim(
    @CurrentUser() user: { sub: string },
    @Param('claimId') claimId: string,
    @Body(new ZodValidationPipe(approveAgentRecoveryClaimSchema)) body: ApproveAgentRecoveryClaim,
  ) {
    return this.agentRecoveryService.approveClaim(claimId, user.sub, body);
  }

  @Post('agent-recovery/claims/:claimId/deny')
  denyClaim(
    @CurrentUser() user: { sub: string },
    @Param('claimId') claimId: string,
    @Body(new ZodValidationPipe(denyAgentRecoveryClaimSchema)) body: DenyAgentRecoveryClaim,
  ) {
    return this.agentRecoveryService.denyClaim(claimId, user.sub, body);
  }
}
