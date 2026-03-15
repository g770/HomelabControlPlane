/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes terminal controller request handling for the API service.
 */
import { Body, Controller, Delete, Get, Param, Post, Res } from '@nestjs/common';
import {
  terminalExecuteRequestSchema,
  terminalSshSessionCreateRequestSchema,
  terminalSshSessionInputRequestSchema,
  type TerminalExecuteRequest,
  type TerminalSshSessionCreateRequest,
  type TerminalSshSessionInputRequest,
} from '@homelab/shared';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TerminalService } from './terminal.service';

@Controller('terminal')
/**
 * Implements the terminal controller class.
 */
export class TerminalController {
  constructor(private readonly terminalService: TerminalService) {}

  @Post('hosts/:id/execute')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  executeHostCommand(
    @CurrentUser() user: { sub: string },
    @Param('id') hostId: string,
    @Body(new ZodValidationPipe(terminalExecuteRequestSchema)) body: TerminalExecuteRequest,
  ) {
    return this.terminalService.executeHostCommand(user.sub, hostId, body.command);
  }

  @Post('hosts/:id/ssh/sessions')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  createSshSession(
    @CurrentUser() user: { sub: string },
    @Param('id') hostId: string,
    @Body(new ZodValidationPipe(terminalSshSessionCreateRequestSchema))
    body: TerminalSshSessionCreateRequest,
  ) {
    return this.terminalService.createSshSession(user.sub, hostId, body);
  }

  @Get('sessions/:sessionId/stream')
  streamSession(
    @CurrentUser() user: { sub: string },
    @Param('sessionId') sessionId: string,
    @Res() response: Response,
  ) {
    return this.terminalService.streamSshSession(user.sub, sessionId, response);
  }

  @Post('sessions/:sessionId/input')
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  writeSessionInput(
    @CurrentUser() user: { sub: string },
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(terminalSshSessionInputRequestSchema))
    body: TerminalSshSessionInputRequest,
  ) {
    return this.terminalService.writeSshSessionInput(user.sub, sessionId, body);
  }

  @Delete('sessions/:sessionId')
  closeSession(@CurrentUser() user: { sub: string }, @Param('sessionId') sessionId: string) {
    return this.terminalService.closeSshSession(user.sub, sessionId);
  }
}
