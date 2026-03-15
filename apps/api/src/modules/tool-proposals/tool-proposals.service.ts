/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements tool proposals service business logic for the service layer.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ToolProposalStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { WRITE_TOOLS } from '@homelab/shared';
import { AuditService } from '../audit/audit.service';
import { EventsService } from '../events/events.service';
import { McpService } from '../mcp/mcp.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
/**
 * Implements the tool proposals service class.
 */
export class ToolProposalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly eventsService: EventsService,
    private readonly mcpService: McpService,
  ) {}

  async create(
    userId: string,
    body: {
      agentId: string;
      toolName: string;
      params: Record<string, unknown>;
      reason: string;
      highRiskConfirmed?: boolean;
    },
  ) {
    if (!WRITE_TOOLS.has(body.toolName)) {
      throw new BadRequestException('Proposal endpoint is only for write tools');
    }

    const proposal = await this.prisma.mcpToolProposal.create({
      data: {
        requestedByUserId: userId,
        agentId: body.agentId,
        toolName: body.toolName,
        params: body.params as Prisma.InputJsonValue,
        reason: body.reason,
        status: ToolProposalStatus.PENDING,
        highRiskConfirmed: body.highRiskConfirmed ?? false,
      },
    });

    await this.eventsService.emit({
      type: 'tool_proposal.created',
      message: `Tool proposal ${proposal.toolName} created`,
      payload: { proposalId: proposal.id, agentId: proposal.agentId },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'tool_proposal.create',
      targetType: 'tool_proposal',
      targetId: proposal.id,
      paramsJson: {
        toolName: proposal.toolName,
        agentId: proposal.agentId,
      },
      success: true,
    });

    return proposal;
  }

  /**
   * Handles pending.
   */
  async pending() {
    return this.prisma.mcpToolProposal.findMany({
      where: { status: ToolProposalStatus.PENDING },
      select: {
        id: true,
        requestedByUserId: true,
        agentId: true,
        toolName: true,
        params: true,
        reason: true,
        status: true,
        highRiskConfirmed: true,
        approvalRequestedAt: true,
        approvedByUserId: true,
        approvedAt: true,
        deniedAt: true,
        executedAt: true,
        result: true,
        error: true,
        requestedBy: { select: { id: true, email: true, displayName: true } },
        agent: {
          select: {
            id: true,
            displayName: true,
            hostId: true,
            status: true,
            lastSeenAt: true,
            version: true,
          },
        },
      },
      orderBy: { approvalRequestedAt: 'asc' },
    });
  }

  /**
   * Handles deny.
   */
  async deny(proposalId: string, userId: string, reason?: string) {
    const proposal = await this.prisma.mcpToolProposal.findUnique({ where: { id: proposalId } });
    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }

    if (proposal.status !== ToolProposalStatus.PENDING) {
      throw new BadRequestException('Proposal is not pending');
    }

    const denied = await this.prisma.mcpToolProposal.update({
      where: { id: proposalId },
      data: {
        status: ToolProposalStatus.DENIED,
        deniedAt: new Date(),
        error: reason ?? 'Denied by approver',
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'tool_proposal.deny',
      targetType: 'tool_proposal',
      targetId: proposalId,
      paramsJson: reason ? { reason } : undefined,
      success: true,
    });

    return denied;
  }

  /**
   * Handles approve.
   */
  async approve(proposalId: string, userId: string, secondConfirm: boolean) {
    const proposal = await this.prisma.mcpToolProposal.findUnique({ where: { id: proposalId } });
    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }

    if (proposal.status !== ToolProposalStatus.PENDING) {
      throw new BadRequestException('Proposal is not pending');
    }

    if (proposal.toolName === 'host.reboot') {
      if (!proposal.highRiskConfirmed || !secondConfirm) {
        throw new ForbiddenException('host.reboot requires secondary confirmation');
      }
    }

    await this.prisma.mcpToolProposal.update({
      where: { id: proposal.id },
      data: {
        status: ToolProposalStatus.APPROVED,
        approvedByUserId: userId,
        approvedAt: new Date(),
      },
    });

    try {
      const result = await this.mcpService.callTool({
        actorUserId: userId,
        agentId: proposal.agentId,
        toolName: proposal.toolName,
        toolParams: proposal.params as Record<string, unknown>,
        allowWrite: true,
      });

      const executed = await this.prisma.mcpToolProposal.update({
        where: { id: proposal.id },
        data: {
          status: ToolProposalStatus.EXECUTED,
          executedAt: new Date(),
          result: result as Prisma.InputJsonValue,
          error: null,
        },
      });

      await this.eventsService.emit({
        type: 'tool_proposal.executed',
        message: `Tool proposal executed: ${proposal.toolName}`,
        payload: { proposalId: proposal.id, agentId: proposal.agentId },
      });

      await this.auditService.write({
        actorUserId: userId,
        action: 'tool_proposal.approve_execute',
        targetType: 'tool_proposal',
        targetId: proposal.id,
        paramsJson: { toolName: proposal.toolName },
        success: true,
      });

      return executed;
    } catch (error) {
      const failed = await this.prisma.mcpToolProposal.update({
        where: { id: proposal.id },
        data: {
          status: ToolProposalStatus.FAILED,
          executedAt: new Date(),
          error: error instanceof Error ? error.message : 'Unknown execution failure',
        },
      });

      await this.auditService.write({
        actorUserId: userId,
        action: 'tool_proposal.approve_execute',
        targetType: 'tool_proposal',
        targetId: proposal.id,
        resultJson: {
          error: error instanceof Error ? error.message : 'Unknown execution failure',
        },
        success: false,
      });

      return failed;
    }
  }
}
