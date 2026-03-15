/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes tool proposals controller request handling for the API service.
 */
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  createToolProposalSchema,
  toolProposalApproveSchema,
  toolProposalDenySchema,
  type CreateToolProposal,
  type ToolProposalApprove,
  type ToolProposalDeny,
} from '@homelab/shared';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ToolProposalsService } from './tool-proposals.service';

@Controller('tool-proposals')
/**
 * Implements the tool proposals controller class.
 */
export class ToolProposalsController {
  constructor(private readonly toolProposalsService: ToolProposalsService) {}

  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  create(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(createToolProposalSchema)) body: CreateToolProposal,
  ) {
    return this.toolProposalsService.create(user.sub, body);
  }

  @Get()
  /**
   * Handles pending.
   */
  pending() {
    return this.toolProposalsService.pending();
  }

  @Post(':id/approve')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  approve(
    @CurrentUser() user: { sub: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(toolProposalApproveSchema)) body: ToolProposalApprove,
  ) {
    return this.toolProposalsService.approve(id, user.sub, body.secondConfirm ?? false);
  }

  @Post(':id/deny')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  deny(
    @CurrentUser() user: { sub: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(toolProposalDenySchema)) body: ToolProposalDeny,
  ) {
    return this.toolProposalsService.deny(id, user.sub, body.reason);
  }
}
