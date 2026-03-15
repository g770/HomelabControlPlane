/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes mcp controller request handling for the API service.
 */
import { Body, Controller, Post } from '@nestjs/common';
import { mcpToolCallSchema, type McpToolCall } from '@homelab/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { McpService } from './mcp.service';

@Controller('mcp')
/**
 * Implements the mcp controller class.
 */
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  @Post('call')
  call(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(mcpToolCallSchema)) body: McpToolCall,
  ) {
    return this.mcpService.callTool({
      actorUserId: user.sub,
      agentId: body.agentId,
      toolName: body.toolName,
      toolParams: body.params,
    });
  }
}
