/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements ai service business logic for the service layer.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ToolProposalStatus, type Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { McpService } from '../mcp/mcp.service';
import { ToolProposalsService } from '../tool-proposals/tool-proposals.service';
import { AiProviderService } from './ai-provider.service';
import {
  CHAT_MEMORY_COMPACTION_BATCH_MESSAGES,
  CHAT_MEMORY_COMPACTION_TRIGGER_MESSAGES,
  CHAT_MEMORY_RECENT_MESSAGES,
  type ChatMemorySummary,
  type ChatRecentTurn,
  emptyChatMemorySummary,
  mergeChatMemorySummary,
  parseChatMemorySummary,
  readChatMemorySummaryFromJson,
  sanitizeChatMemoryText,
  toRecentTurns,
} from './ai-chat-memory';
import {
  AI_PERSONALITY_MEMORY_KEY,
  DEFAULT_AI_PERSONALITY,
  buildPersonalitySystemPrompt,
  readAiPersonalityFromJson,
  sanitizeAiPersonality,
} from './ai-personality';

// Input shape for conversational assistant requests.
type ChatInput = {
  conversationId?: string;
  message: string;
  contextHostId?: string;
};

/**
 * Describes the chat event shape.
 */
export type ChatEvent =
  | { type: 'status'; payload: Record<string, unknown> }
  | { type: 'trace'; payload: Record<string, unknown> }
  | { type: 'token'; payload: Record<string, unknown> }
  | { type: 'done'; payload: Record<string, unknown> };

type HostSummarySection = {
  title: string;
  bullets: string[];
};

type HostDetailSummary = {
  hostId: string;
  hostName: string;
  generatedAt: string;
  generatedByAi: boolean;
  overview: string[];
  sections: {
    facts: HostSummarySection;
    containers: HostSummarySection;
    systemServices: HostSummarySection;
    storage: HostSummarySection;
    network: HostSummarySection;
  };
};

type ChatHistoryContext = {
  summary: ChatMemorySummary;
  recentTurns: ChatRecentTurn[];
};

const aiHostSummarySchema = z
  .object({
    overview: z.array(z.string().min(1).max(180)).min(2).max(8),
    sections: z
      .object({
        facts: z.array(z.string().min(1).max(180)).min(1).max(8),
        containers: z.array(z.string().min(1).max(180)).min(1).max(8),
        systemServices: z.array(z.string().min(1).max(180)).min(1).max(8),
        storage: z.array(z.string().min(1).max(180)).min(1).max(8),
        network: z.array(z.string().min(1).max(180)).min(1).max(8),
      })
      .strict(),
  })
  .strict();

// Central AI orchestration service for chat, host summaries, and personality.
@Injectable()
/**
 * Implements the ai service class.
 */
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly mcpService: McpService,
    private readonly toolProposalsService: ToolProposalsService,
    private readonly aiProviderService: AiProviderService,
  ) {}

  // Reports whether OpenAI credentials are configured.
  async status() {
    return { enabled: await this.aiProviderService.isConfigured() };
  }

  // Returns persisted personality or built-in default behavior.
  async getPersonality(userId: string) {
    const existing = await this.prisma.opsMemory.findUnique({
      where: {
        userId_key: {
          userId,
          key: AI_PERSONALITY_MEMORY_KEY,
        },
      },
    });
    const stored = readAiPersonalityFromJson(existing?.value);
    return {
      personality: stored ?? DEFAULT_AI_PERSONALITY,
      isCustom: Boolean(stored),
      updatedAt: existing ? existing.updatedAt.toISOString() : null,
    };
  }

  // Stores or clears custom personality and writes audit metadata.
  async setPersonality(userId: string, personality: string) {
    const sanitized = sanitizeAiPersonality(personality);

    if (!sanitized) {
      const existing = await this.prisma.opsMemory.findUnique({
        where: {
          userId_key: {
            userId,
            key: AI_PERSONALITY_MEMORY_KEY,
          },
        },
      });

      if (existing) {
        await this.prisma.opsMemory.delete({
          where: {
            userId_key: {
              userId,
              key: AI_PERSONALITY_MEMORY_KEY,
            },
          },
        });

        await this.auditService.write({
          actorUserId: userId,
          action: 'ai.personality.update',
          targetType: 'ops_memory',
          targetId: existing.id,
          paramsJson: { custom: false, length: 0 },
          success: true,
        });
      } else {
        await this.auditService.write({
          actorUserId: userId,
          action: 'ai.personality.update',
          targetType: 'ops_memory',
          paramsJson: { custom: false, length: 0 },
          success: true,
        });
      }

      return this.getPersonality(userId);
    }

    const saved = await this.prisma.opsMemory.upsert({
      where: {
        userId_key: {
          userId,
          key: AI_PERSONALITY_MEMORY_KEY,
        },
      },
      update: {
        value: {
          personality: sanitized,
        } as Prisma.InputJsonValue,
      },
      create: {
        userId,
        key: AI_PERSONALITY_MEMORY_KEY,
        value: {
          personality: sanitized,
        } as Prisma.InputJsonValue,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'ai.personality.update',
      targetType: 'ops_memory',
      targetId: saved.id,
      paramsJson: { custom: true, length: sanitized.length },
      success: true,
    });

    return this.getPersonality(userId);
  }

  // Conversation list for AI history UI.
  async listConversations(userId: string) {
    return this.prisma.aiConversation.findMany({
      where: { userId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 40,
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
  }

  // Removes a conversation owned by the caller.
  async deleteConversation(userId: string, conversationId: string) {
    const conversation = await this.prisma.aiConversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation || conversation.userId !== userId) {
      throw new NotFoundException('Conversation not found');
    }

    await this.prisma.aiConversation.delete({ where: { id: conversationId } });
    return { ok: true };
  }

  // Updates per-conversation retention with bounded day limits.
  async setRetention(userId: string, conversationId: string, retentionDays: number) {
    const conversation = await this.prisma.aiConversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation || conversation.userId != userId) {
      throw new NotFoundException('Conversation not found');
    }

    return this.prisma.aiConversation.update({
      where: { id: conversationId },
      data: { retentionDays: Math.max(1, Math.min(retentionDays, 365)) },
    });
  }

  // Produces human-readable host detail bullets from telemetry and snapshots.
  async summarizeHostDetails(hostId: string, userId: string): Promise<HostDetailSummary> {
    const host = await this.prisma.host.findUnique({
      where: { id: hostId },
      select: {
        id: true,
        hostname: true,
        status: true,
        cpuPct: true,
        memPct: true,
        diskPct: true,
        lastSeenAt: true,
        facts: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            createdAt: true,
            snapshot: true,
          },
        },
        serviceInstances: {
          take: 40,
          select: {
            name: true,
            status: true,
            endpoint: true,
          },
        },
      },
    });

    if (!host) {
      throw new NotFoundException('Host not found');
    }

    const latestFact = host.facts[0];
    const snapshot = toRecord(latestFact?.snapshot);
    const fallback = buildFallbackHostSummary(host, snapshot, latestFact?.createdAt ?? null);

    const openai = await this.aiProviderService.getClient();
    if (!openai) {
      return fallback;
    }

    const personality = await this.resolveUserPersonality(userId);

    try {
      const response = await openai.responses.create({
        model: this.aiProviderService.getModel(),
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: buildPersonalitySystemPrompt(
                  [
                    'You summarize host telemetry for operators.',
                    'Return valid JSON only, no markdown, no prose outside JSON.',
                    'Keep each bullet concise and actionable.',
                    'Do not invent values that are not present in the input.',
                    'Use this shape exactly:',
                    JSON.stringify({
                      overview: ['...'],
                      sections: {
                        facts: ['...'],
                        containers: ['...'],
                        systemServices: ['...'],
                        storage: ['...'],
                        network: ['...'],
                      },
                    }),
                  ].join(' '),
                  personality,
                ),
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({
                  host: {
                    id: host.id,
                    hostname: host.hostname,
                    status: host.status,
                    cpuPct: host.cpuPct,
                    memPct: host.memPct,
                    diskPct: host.diskPct,
                    lastSeenAt: host.lastSeenAt ? host.lastSeenAt.toISOString() : null,
                    services: host.serviceInstances.map((instance) => ({
                      name: instance.name,
                      status: instance.status,
                      endpoint: instance.endpoint,
                    })),
                  },
                  snapshot: {
                    cpu: snapshot?.cpu ?? null,
                    memory: snapshot?.memory ?? null,
                    storage: snapshot?.storage ?? null,
                    network: snapshot?.network ?? null,
                    containers: snapshot?.containers ?? null,
                    systemd: snapshot?.systemd ?? null,
                  },
                  factCapturedAt: latestFact?.createdAt ? latestFact.createdAt.toISOString() : null,
                }),
              },
            ],
          },
        ],
      });

      const aiParsed = parseAiHostSummary(response.output_text ?? '');
      if (!aiParsed) {
        return fallback;
      }
      const normalizedAiSummary = normalizeAiSummaryDecimals(aiParsed);

      return {
        ...fallback,
        generatedByAi: true,
        overview: normalizedAiSummary.overview,
        sections: {
          facts: { ...fallback.sections.facts, bullets: normalizedAiSummary.sections.facts },
          containers: {
            ...fallback.sections.containers,
            bullets: normalizedAiSummary.sections.containers,
          },
          systemServices: {
            ...fallback.sections.systemServices,
            bullets: normalizedAiSummary.sections.systemServices,
          },
          storage: { ...fallback.sections.storage, bullets: normalizedAiSummary.sections.storage },
          network: { ...fallback.sections.network, bullets: normalizedAiSummary.sections.network },
        },
      };
    } catch {
      return fallback;
    }
  }

  // Streaming chat pipeline that gathers context, traces tool calls, and emits
  // status/token/done events for SSE clients.
  async *chat(userId: string, input: ChatInput): AsyncGenerator<ChatEvent> {
    const conversation = await this.getOrCreateConversation(userId, input);

    const persistedUserMessage = await this.prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'USER',
        content: input.message,
      },
      select: {
        id: true,
      },
    });

    yield {
      type: 'status',
      payload: { stage: 'context', conversationId: conversation.id },
    };

    const [hostCount, serviceCount, activeAlerts, recentEvents] = await Promise.all([
      this.prisma.host.count(),
      this.prisma.service.count(),
      this.prisma.alertEvent.count({ where: { status: { in: ['PENDING', 'FIRING'] } } }),
      this.prisma.event.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { type: true, message: true, severity: true, createdAt: true },
      }),
    ]);

    const traces: Array<Record<string, unknown>> = [];
    const contextHostId = await this.resolveContextHostId(input.message, input.contextHostId);
    let proposalId: string | null = null;
    let createdWriteProposal: {
      id: string;
      toolName: string;
      params: Record<string, unknown>;
      agentId: string;
      highRisk: boolean;
    } | null = null;

    const requestedWriteTool = this.detectWriteAction(input.message);
    if (requestedWriteTool && contextHostId) {
      const agent = await this.findAgentForHost(contextHostId);

      if (agent) {
        const proposal = await this.toolProposalsService.create(userId, {
          agentId: agent.id,
          toolName: requestedWriteTool.tool,
          params: requestedWriteTool.params,
          reason: `AI requested from chat: ${input.message}`,
          highRiskConfirmed: false,
        });

        proposalId = proposal.id;
        createdWriteProposal = {
          id: proposal.id,
          toolName: proposal.toolName,
          params: toRecord(proposal.params) ?? {},
          agentId: proposal.agentId,
          highRisk: proposal.toolName === 'host.reboot',
        };
        traces.push({
          kind: 'proposal',
          tool: requestedWriteTool.tool,
          agentId: agent.id,
          params: requestedWriteTool.params,
          proposalId: proposal.id,
        });

        yield {
          type: 'trace',
          payload: traces[traces.length - 1] ?? {},
        };

        await this.prisma.opsMemory.upsert({
          where: {
            userId_key: {
              userId,
              key: 'last_proposed_tool',
            },
          },
          update: {
            value: {
              tool: requestedWriteTool.tool,
              at: new Date().toISOString(),
            },
          },
          create: {
            userId,
            key: 'last_proposed_tool',
            value: {
              tool: requestedWriteTool.tool,
              at: new Date().toISOString(),
            },
          },
        });
      }
    }

    if (contextHostId) {
      const agent = await this.findAgentForHost(contextHostId);
      if (agent) {
        const readPlan = this.planReadToolCalls(input.message);
        const plannedCalls = [
          {
            toolName: 'host.status',
            toolParams: {},
            reason: 'base_host_context',
          },
          ...readPlan,
        ];
        const seenCalls = new Set<string>();
        const boundedCalls = plannedCalls.filter((call) => {
          const key = `${call.toolName}:${JSON.stringify(call.toolParams)}`;
          if (seenCalls.has(key)) {
            return false;
          }
          seenCalls.add(key);
          return true;
        });

        for (const call of boundedCalls.slice(0, 3)) {
          try {
            const readResult = await this.mcpService.callTool({
              actorUserId: userId,
              agentId: agent.id,
              toolName: call.toolName,
              toolParams: call.toolParams,
            });

            traces.push({
              kind: 'tool',
              tool: call.toolName,
              params: call.toolParams,
              reason: call.reason,
              agentId: agent.id,
              result: readResult,
            });
          } catch (error) {
            traces.push({
              kind: 'tool',
              tool: call.toolName,
              params: call.toolParams,
              reason: call.reason,
              agentId: agent.id,
              error: error instanceof Error ? error.message : 'read failed',
            });
            const classified = classifyToolError(error);
            if (classified.kind === 'auth') {
              traces[traces.length - 1] = {
                ...traces[traces.length - 1],
                kind: 'tool_auth_error',
                statusCode: classified.statusCode ?? null,
                remediation:
                  'Agent MCP authentication failed. Re-enroll the agent (or rotate agent credentials) and retry.',
              };
            }
          }

          yield {
            type: 'trace',
            payload: traces[traces.length - 1] ?? {},
          };
        }
      } else {
        traces.push({
          kind: 'tool',
          tool: 'host.status',
          error: 'No active agent found for selected host context.',
        });
        yield {
          type: 'trace',
          payload: traces[traces.length - 1] ?? {},
        };
      }
    }

    const aiEnabled = await this.aiProviderService.isConfigured();
    const context = {
      hostCount,
      serviceCount,
      activeAlerts,
      recentEvents,
      contextHostId,
      traces,
      hasOpenAi: aiEnabled,
    };

    let answer: string;
    const authFailureTraces = traces.filter((trace) => trace.kind === 'tool_auth_error');
    const decision = parseProposalDecisionIntent(input.message);
    if (!proposalId && decision) {
      const handledDecision = await this.handlePendingProposalDecision({
        userId,
        conversationId: conversation.id,
        decision,
      });
      if (handledDecision.trace) {
        traces.push(handledDecision.trace);
        yield {
          type: 'trace',
          payload: traces[traces.length - 1] ?? {},
        };
      }
      answer = handledDecision.answer;
      proposalId = handledDecision.proposalId;
    } else if (createdWriteProposal) {
      traces.push({
        kind: 'proposal_prompted',
        tool: createdWriteProposal.toolName,
        agentId: createdWriteProposal.agentId,
        params: createdWriteProposal.params,
        proposalId: createdWriteProposal.id,
      });
      yield {
        type: 'trace',
        payload: traces[traces.length - 1] ?? {},
      };

      answer = buildWriteProposalPrompt({
        proposalId: createdWriteProposal.id,
        toolName: createdWriteProposal.toolName,
        params: createdWriteProposal.params,
        highRisk: createdWriteProposal.highRisk,
      });
      proposalId = createdWriteProposal.id;
    } else if (authFailureTraces.length > 0) {
      answer = buildAgentAuthFailureResponse(contextHostId, authFailureTraces);
    } else {
      const personality = await this.resolveUserPersonality(userId);
      const history = await this.buildChatHistoryContext({
        userId,
        conversationId: conversation.id,
        currentMessageId: persistedUserMessage.id,
      });
      answer = await this.generateAnswer(input.message, context, proposalId, personality, history);
    }

    await this.prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'ASSISTANT',
        content: answer,
        toolResult: {
          traces,
          proposalId,
        } as Prisma.InputJsonValue,
      },
    });

    await this.prisma.aiConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    yield {
      type: 'token',
      payload: {
        content: answer,
      },
    };

    yield {
      type: 'done',
      payload: {
        conversationId: conversation.id,
        traces,
        proposalId,
        aiEnabled,
      },
    };
  }

  private async generateAnswer(
    userMessage: string,
    context: {
      hostCount: number;
      serviceCount: number;
      activeAlerts: number;
      recentEvents: Array<Record<string, unknown>>;
      contextHostId?: string;
      traces: Array<Record<string, unknown>>;
      hasOpenAi: boolean;
    },
    proposalId: string | null,
    personality: string,
    history: ChatHistoryContext,
  ) {
    const openai = await this.aiProviderService.getClient();
    if (!openai) {
      const suffix = proposalId
        ? `I created write-action proposal ${proposalId}. Approve it before execution.`
        : 'Configure an OpenAI API key in Settings to enable richer AI responses.';

      return `AI is disabled. Current state: ${context.hostCount} hosts, ${context.serviceCount} services, ${context.activeAlerts} active alerts. ${suffix}`;
    }

    const systemPrompt = [
      'You are an operations assistant for a homelab control plane.',
      'Never claim write actions are executed unless trace confirms execution.',
      'If a proposalId is present, ask user to confirm or deny it in chat.',
      'Never ask for approval for read-only tool execution.',
      'When trace data includes successful tool results, answer directly from that data.',
      'Do not ask the user what command to run if relevant read results already exist.',
      'Only request a command from the user if no relevant trace data is available.',
      'Use history.summary and history.recentTurns to preserve continuity across messages.',
      'Keep answers concise and action-oriented.',
    ].join(' ');

    const response = await openai.responses.create({
      model: this.aiProviderService.getModel(),
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: buildPersonalitySystemPrompt(systemPrompt, personality),
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                message: userMessage,
                history,
                context,
                proposalId,
              }),
            },
          ],
        },
      ],
    });

    const text = response.output_text?.trim();
    return text && text.length > 0
      ? text
      : 'No model output. Review tool traces and current alerts for next action.';
  }

  private async handlePendingProposalDecision(input: {
    userId: string;
    conversationId: string;
    decision: ProposalDecisionIntent;
  }): Promise<{ answer: string; proposalId: string | null; trace?: Record<string, unknown> }> {
    const pendingLookup = await this.resolveLatestPendingConversationProposal({
      userId: input.userId,
      conversationId: input.conversationId,
      requestedProposalId: input.decision.proposalId,
    });
    if (!pendingLookup.proposal) {
      const response =
        pendingLookup.reason === 'not_in_conversation'
          ? 'That proposal was not created in this chat. Reply "yes" or "no" for the latest proposal shown here.'
          : 'No pending write proposal was found in this chat. Ask for a write action first.';
      return {
        answer: response,
        proposalId: null,
        trace: {
          kind: 'proposal_not_found',
          reason: pendingLookup.reason ?? 'none',
          requestedProposalId: input.decision.proposalId ?? null,
        },
      };
    }

    const pending = pendingLookup.proposal;

    if (input.decision.kind === 'deny') {
      const denied = await this.toolProposalsService.deny(
        pending.id,
        input.userId,
        'Denied from AI chat',
      );
      return {
        answer: `Denied proposal ${denied.id} (${denied.toolName}). No write action was executed.`,
        proposalId: denied.id,
        trace: {
          kind: 'proposal_denied',
          tool: denied.toolName,
          proposalId: denied.id,
          agentId: denied.agentId,
        },
      };
    }

    if (pending.toolName === 'host.reboot') {
      if (input.decision.kind === 'reboot_confirm') {
        if (!pending.highRiskConfirmed) {
          return {
            answer: `I still need an initial approval for reboot proposal ${pending.id}. Reply "yes" first, then confirm with "confirm reboot ${pending.id}".`,
            proposalId: pending.id,
            trace: {
              kind: 'proposal_second_confirm_required',
              tool: pending.toolName,
              proposalId: pending.id,
              agentId: pending.agentId,
            },
          };
        }

        const executed = await this.toolProposalsService.approve(pending.id, input.userId, true);
        return {
          answer: buildProposalExecutionResponse(executed),
          proposalId: executed.id,
          trace: {
            kind:
              executed.status === ToolProposalStatus.EXECUTED
                ? 'proposal_approved'
                : 'proposal_approval_failed',
            tool: executed.toolName,
            proposalId: executed.id,
            agentId: executed.agentId,
            status: executed.status,
            error: executed.error,
          },
        };
      }

      if (!pending.highRiskConfirmed) {
        await this.confirmHighRiskProposal(pending.id, input.userId);
      }

      return {
        answer: `Reboot proposal ${pending.id} is staged. To execute it, reply exactly: "confirm reboot ${pending.id}". Reply "no" to cancel.`,
        proposalId: pending.id,
        trace: {
          kind: 'proposal_second_confirm_required',
          tool: pending.toolName,
          proposalId: pending.id,
          agentId: pending.agentId,
        },
      };
    }

    if (input.decision.kind === 'reboot_confirm') {
      return {
        answer: `Pending proposal ${pending.id} is for ${pending.toolName}, not reboot. Reply "yes" to approve or "no" to deny.`,
        proposalId: pending.id,
        trace: {
          kind: 'proposal_mismatch',
          tool: pending.toolName,
          proposalId: pending.id,
        },
      };
    }

    const executed = await this.toolProposalsService.approve(pending.id, input.userId, false);
    return {
      answer: buildProposalExecutionResponse(executed),
      proposalId: executed.id,
      trace: {
        kind:
          executed.status === ToolProposalStatus.EXECUTED
            ? 'proposal_approved'
            : 'proposal_approval_failed',
        tool: executed.toolName,
        proposalId: executed.id,
        agentId: executed.agentId,
        status: executed.status,
        error: executed.error,
      },
    };
  }

  private async resolveLatestPendingConversationProposal(input: {
    userId: string;
    conversationId: string;
    requestedProposalId?: string;
  }): Promise<{
    proposal: {
      id: string;
      toolName: string;
      agentId: string;
      params: Record<string, unknown>;
      highRiskConfirmed: boolean;
    } | null;
    reason?: 'not_in_conversation';
  }> {
    const assistantMessages = await this.prisma.aiMessage.findMany({
      where: {
        conversationId: input.conversationId,
        role: 'ASSISTANT',
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 80,
      select: {
        toolResult: true,
      },
    });

    const seen = new Set<string>();
    const proposalIds: string[] = [];
    for (const message of assistantMessages) {
      const result = toRecord(message.toolResult);
      const proposalId = typeof result?.proposalId === 'string' ? result.proposalId : null;
      if (!proposalId || seen.has(proposalId)) {
        continue;
      }
      seen.add(proposalId);
      proposalIds.push(proposalId);
    }

    if (proposalIds.length === 0) {
      return { proposal: null };
    }

    let orderedIds = proposalIds;
    if (input.requestedProposalId) {
      if (!proposalIds.includes(input.requestedProposalId)) {
        return { proposal: null, reason: 'not_in_conversation' };
      }
      orderedIds = [
        input.requestedProposalId,
        ...proposalIds.filter((id) => id !== input.requestedProposalId),
      ];
    }

    const pending = await this.prisma.mcpToolProposal.findMany({
      where: {
        id: { in: orderedIds },
        requestedByUserId: input.userId,
        status: ToolProposalStatus.PENDING,
      },
      select: {
        id: true,
        toolName: true,
        agentId: true,
        params: true,
        highRiskConfirmed: true,
      },
    });
    const byId = new Map(pending.map((proposal) => [proposal.id, proposal]));

    for (const proposalId of orderedIds) {
      const proposal = byId.get(proposalId);
      if (!proposal) {
        continue;
      }
      return {
        proposal: {
          id: proposal.id,
          toolName: proposal.toolName,
          agentId: proposal.agentId,
          params: toRecord(proposal.params) ?? {},
          highRiskConfirmed: proposal.highRiskConfirmed,
        },
      };
    }

    return { proposal: null };
  }

  /**
   * Handles confirm high risk proposal.
   */
  private async confirmHighRiskProposal(proposalId: string, userId: string) {
    await this.prisma.mcpToolProposal.update({
      where: { id: proposalId },
      data: {
        highRiskConfirmed: true,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'tool_proposal.high_risk_confirm',
      targetType: 'tool_proposal',
      targetId: proposalId,
      success: true,
    });
  }

  private async buildChatHistoryContext(input: {
    userId: string;
    conversationId: string;
    currentMessageId: string;
  }): Promise<ChatHistoryContext> {
    const memoryKey = conversationHistoryMemoryKey(input.conversationId);
    const storedMemory = await this.prisma.opsMemory.findUnique({
      where: {
        userId_key: {
          userId: input.userId,
          key: memoryKey,
        },
      },
      select: {
        id: true,
        value: true,
      },
    });
    const memoryRecord = toRecord(storedMemory?.value);

    let summary = readChatMemorySummaryFromJson(
      (memoryRecord?.summary ?? null) as Prisma.JsonValue | null,
    );
    let cursorMessageId =
      typeof memoryRecord?.cursorMessageId === 'string' ? memoryRecord.cursorMessageId : null;
    let cursorCreatedAt = parseIsoDate(memoryRecord?.cursorCreatedAt);

    if ((cursorMessageId && !cursorCreatedAt) || (!cursorMessageId && cursorCreatedAt)) {
      await this.resetChatHistoryMemory(input.userId, input.conversationId);
      summary = emptyChatMemorySummary();
      cursorMessageId = null;
      cursorCreatedAt = null;
    } else if (cursorMessageId && cursorCreatedAt) {
      const existingCursor = await this.prisma.aiMessage.findFirst({
        where: {
          conversationId: input.conversationId,
          id: cursorMessageId,
        },
        select: {
          id: true,
        },
      });

      if (!existingCursor) {
        await this.resetChatHistoryMemory(input.userId, input.conversationId);
        summary = emptyChatMemorySummary();
        cursorMessageId = null;
        cursorCreatedAt = null;
      }
    }

    const recentMessagesDesc = await this.prisma.aiMessage.findMany({
      where: {
        conversationId: input.conversationId,
        id: { not: input.currentMessageId },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CHAT_MEMORY_RECENT_MESSAGES,
      select: {
        id: true,
        role: true,
        content: true,
        createdAt: true,
      },
    });
    const { recentTurns, oldestIncludedMessage } = toRecentTurns(
      recentMessagesDesc,
      CHAT_MEMORY_RECENT_MESSAGES,
    );

    const openai = await this.aiProviderService.getClient();
    if (!openai) {
      return { summary, recentTurns };
    }

    const unsummarizedFilters = buildUnsummarizedHistoryFilters({
      cursorMessageId,
      cursorCreatedAt,
      oldestIncludedMessage,
    });
    const unsummarizedWhere: Prisma.AiMessageWhereInput = {
      conversationId: input.conversationId,
      id: { not: input.currentMessageId },
      ...(unsummarizedFilters.length > 0 ? { AND: unsummarizedFilters } : {}),
    };

    const unsummarizedCount = await this.prisma.aiMessage.count({
      where: unsummarizedWhere,
    });
    if (unsummarizedCount < CHAT_MEMORY_COMPACTION_TRIGGER_MESSAGES) {
      return { summary, recentTurns };
    }

    const chunk = await this.prisma.aiMessage.findMany({
      where: unsummarizedWhere,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: CHAT_MEMORY_COMPACTION_BATCH_MESSAGES,
      select: {
        id: true,
        role: true,
        content: true,
        createdAt: true,
      },
    });
    if (chunk.length === 0) {
      return { summary, recentTurns };
    }

    const compacted = await this.summarizeConversationHistoryChunk(summary, chunk, openai);
    if (!compacted) {
      return { summary, recentTurns };
    }

    summary = mergeChatMemorySummary(summary, compacted);
    const lastMessage = chunk[chunk.length - 1];
    if (!lastMessage) {
      return { summary, recentTurns };
    }

    const savedMemory = await this.prisma.opsMemory.upsert({
      where: {
        userId_key: {
          userId: input.userId,
          key: memoryKey,
        },
      },
      update: {
        value: {
          summary,
          cursorMessageId: lastMessage.id,
          cursorCreatedAt: lastMessage.createdAt.toISOString(),
          updatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
      create: {
        userId: input.userId,
        key: memoryKey,
        value: {
          summary,
          cursorMessageId: lastMessage.id,
          cursorCreatedAt: lastMessage.createdAt.toISOString(),
          updatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    await this.auditService.write({
      actorUserId: input.userId,
      action: 'ai.memory.compact',
      targetType: 'ops_memory',
      targetId: savedMemory.id,
      paramsJson: {
        conversationId: input.conversationId,
        chunkMessages: chunk.length,
        unsummarizedCount,
        recentTurns: recentTurns.length,
        summaryBuckets: {
          facts: summary.facts.length,
          decisions: summary.decisions.length,
          pendingActions: summary.pendingActions.length,
          openQuestions: summary.openQuestions.length,
          userPreferences: summary.userPreferences.length,
          importantIds: summary.importantIds.length,
        },
      },
      success: true,
    });

    return { summary, recentTurns };
  }

  private async summarizeConversationHistoryChunk(
    existingSummary: ChatMemorySummary,
    chunk: Array<{ id: string; role: string; content: string; createdAt: Date }>,
    openai: {
      responses: {
        create: (input: Record<string, unknown>) => Promise<{ output_text?: string | null }>;
      };
    },
  ) {
    try {
      const response = await openai.responses.create({
        model: this.aiProviderService.getModel(),
        max_output_tokens: 1_200,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: [
                  'You maintain compact conversation memory for a homelab operations assistant.',
                  'Return valid JSON only, with no markdown or prose outside JSON.',
                  'Use exactly this shape:',
                  JSON.stringify({
                    facts: ['...'],
                    decisions: ['...'],
                    pendingActions: ['...'],
                    openQuestions: ['...'],
                    userPreferences: ['...'],
                    importantIds: ['...'],
                  }),
                  'Only include durable context helpful for future turns.',
                  'Use concise, actionable entries.',
                  'Never include raw credentials, tokens, API keys, or secrets. Use [REDACTED] when needed.',
                  'Do not invent facts.',
                ].join(' '),
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({
                  existingSummary,
                  newMessages: chunk.map((message) => ({
                    role: message.role === 'ASSISTANT' ? 'assistant' : 'user',
                    content: sanitizeChatMemoryText(message.content),
                    createdAt: message.createdAt.toISOString(),
                  })),
                }),
              },
            ],
          },
        ],
      });

      return parseChatMemorySummary(response.output_text ?? '');
    } catch {
      return null;
    }
  }

  /**
   * Handles reset chat history memory.
   */
  private async resetChatHistoryMemory(userId: string, conversationId: string) {
    const key = conversationHistoryMemoryKey(conversationId);
    const existing = await this.prisma.opsMemory.findUnique({
      where: {
        userId_key: {
          userId,
          key,
        },
      },
      select: {
        id: true,
      },
    });
    if (!existing) {
      return;
    }

    await this.prisma.opsMemory.delete({
      where: {
        userId_key: {
          userId,
          key,
        },
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'ai.memory.reset',
      targetType: 'ops_memory',
      targetId: existing.id,
      paramsJson: {
        conversationId,
      },
      success: true,
    });
  }

  /**
   * Gets or create conversation.
   */
  private async getOrCreateConversation(userId: string, input: ChatInput) {
    if (input.conversationId) {
      const existing = await this.prisma.aiConversation.findUnique({
        where: { id: input.conversationId },
      });
      if (existing && existing.userId === userId) {
        return existing;
      }
    }

    const title = input.message.slice(0, 60);
    const retentionDays = this.configService.get<number>('AI_RETENTION_DAYS', 30);

    return this.prisma.aiConversation.create({
      data: {
        userId,
        title,
        retentionDays,
      },
    });
  }

  // Heuristic write-intent detector used to create approval-gated proposals.
  private detectWriteAction(message: string): {
    tool: 'services.restart' | 'containers.restart' | 'compose.redeploy' | 'host.reboot';
    params: Record<string, unknown>;
  } | null {
    const lower = message.toLowerCase();

    if (lower.includes('reboot')) {
      return { tool: 'host.reboot', params: {} };
    }

    if (lower.includes('redeploy')) {
      const project = this.extractQuotedOrLastWord(message);
      return { tool: 'compose.redeploy', params: { project } };
    }

    if (lower.includes('restart container')) {
      const id = this.extractQuotedOrLastWord(message);
      return { tool: 'containers.restart', params: { id } };
    }

    if (lower.includes('restart service') || lower.includes('restart')) {
      const name = this.extractQuotedOrLastWord(message);
      return { tool: 'services.restart', params: { name } };
    }

    return null;
  }

  /**
   * Implements the extract quoted or last word workflow for this file.
   */
  private extractQuotedOrLastWord(message: string): string {
    const quotedMatch = message.match(/"([^"]+)"/);
    if (quotedMatch?.[1]) {
      return quotedMatch[1];
    }

    const words = message.trim().split(/\s+/);
    return words[words.length - 1] ?? 'unknown';
  }

  /**
   * Handles find agent for host.
   */
  private async findAgentForHost(hostId: string) {
    return this.prisma.agent.findFirst({
      where: {
        hostId,
        revokedAt: null,
      },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  /**
   * Handles resolve user personality.
   */
  private async resolveUserPersonality(userId: string) {
    const setting = await this.prisma.opsMemory.findUnique({
      where: {
        userId_key: {
          userId,
          key: AI_PERSONALITY_MEMORY_KEY,
        },
      },
      select: {
        value: true,
      },
    });

    return readAiPersonalityFromJson(setting?.value) ?? DEFAULT_AI_PERSONALITY;
  }
  // Finds a usable host context from explicit input, host name mention, or
  // single-host deployments.
  private async resolveContextHostId(message: string, explicitHostId?: string) {
    if (explicitHostId) {
      return explicitHostId;
    }

    const hosts = await this.prisma.host.findMany({
      select: {
        id: true,
        hostname: true,
      },
      orderBy: {
        hostname: 'asc',
      },
      take: 200,
    });
    if (hosts.length === 1) {
      return hosts[0]?.id;
    }

    const lowerMessage = message.toLowerCase();
    const matches = hosts.filter((host) => lowerMessage.includes(host.hostname.toLowerCase()));
    if (matches.length === 1) {
      return matches[0]?.id;
    }

    return undefined;
  }

  // Read-only tool planner for common investigative intents.
  private planReadToolCalls(
    message: string,
  ): Array<{ toolName: 'terminal.exec'; toolParams: Record<string, unknown>; reason: string }> {
    const lower = message.toLowerCase();
    const calls: Array<{
      toolName: 'terminal.exec';
      toolParams: Record<string, unknown>;
      reason: string;
    }> = [];

    const asksForFiles =
      (lower.includes('file') ||
        lower.includes('directory') ||
        lower.includes('folder') ||
        lower.includes('list')) &&
      (lower.includes('home') ||
        lower.includes('/home') ||
        lower.includes('/root') ||
        lower.includes('directory'));
    if (asksForFiles || /\bls\b/.test(lower)) {
      const path = extractListPath(message);
      calls.push({
        toolName: 'terminal.exec',
        toolParams: {
          command: `ls ${path}`,
        },
        reason: 'list_files',
      });
    }

    if (
      (lower.includes('disk') || lower.includes('filesystem') || lower.includes('storage')) &&
      calls.length < 2
    ) {
      calls.push({
        toolName: 'terminal.exec',
        toolParams: {
          command: 'df',
        },
        reason: 'disk_usage',
      });
    }

    if ((lower.includes('container') || lower.includes('docker')) && calls.length < 2) {
      calls.push({
        toolName: 'terminal.exec',
        toolParams: {
          command: 'containers',
        },
        reason: 'containers_list',
      });
    }

    if ((lower.includes('service') || lower.includes('systemd')) && calls.length < 2) {
      calls.push({
        toolName: 'terminal.exec',
        toolParams: {
          command: 'services',
        },
        reason: 'services_list',
      });
    }

    return calls;
  }
}

type ProposalDecisionIntent =
  | { kind: 'approve'; proposalId?: string }
  | { kind: 'deny'; proposalId?: string }
  | { kind: 'reboot_confirm'; proposalId?: string };

/**
 * Parses proposal decision intent.
 */
function parseProposalDecisionIntent(message: string): ProposalDecisionIntent | null {
  const normalized = message.trim().toLowerCase().replace(/\s+/g, ' ');
  const compact = normalized.replace(/[.!?]+$/g, '').trim();
  if (!compact) {
    return null;
  }

  const rebootMatch = compact.match(/^confirm\s+reboot(?:\s+([0-9a-f-]{36}))?$/i);
  if (rebootMatch) {
    return {
      kind: 'reboot_confirm',
      proposalId: rebootMatch[1]?.toLowerCase(),
    };
  }

  if (
    [
      'yes',
      'y',
      'approve',
      'approved',
      'confirm',
      'go ahead',
      'do it',
      'run it',
      'proceed',
      'sounds good',
    ].includes(compact) ||
    compact.startsWith('approve ')
  ) {
    return { kind: 'approve', proposalId: extractProposalId(compact) ?? undefined };
  }

  if (
    [
      'no',
      'n',
      'deny',
      'denied',
      'cancel',
      'stop',
      'never mind',
      'nevermind',
      'do not',
      "don't",
    ].includes(compact) ||
    compact.startsWith('deny ')
  ) {
    return { kind: 'deny', proposalId: extractProposalId(compact) ?? undefined };
  }

  return null;
}

/**
 * Implements classify tool error.
 */
function classifyToolError(error: unknown): { kind: 'auth' | 'other'; statusCode?: number } {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (
    message.includes('authentication failed') ||
    message.includes('http 401') ||
    message.includes('http 403') ||
    message.includes('unauthorized')
  ) {
    const statusMatch = message.match(/http\s+(\d{3})/);
    const statusCode = statusMatch?.[1] ? Number(statusMatch[1]) : undefined;
    return { kind: 'auth', statusCode };
  }
  return { kind: 'other' };
}

/**
 * Builds write proposal prompt.
 */
function buildWriteProposalPrompt(input: {
  proposalId: string;
  toolName: string;
  params: Record<string, unknown>;
  highRisk: boolean;
}) {
  const paramsText =
    Object.keys(input.params).length > 0 ? ` Params: ${JSON.stringify(input.params)}.` : '';
  const base = `I prepared write proposal ${input.proposalId} for ${input.toolName}.${paramsText} Reply "yes" to approve or "no" to deny.`;
  if (input.highRisk) {
    return `${base} Because reboot is high-risk, execution also requires: "confirm reboot ${input.proposalId}".`;
  }
  return base;
}

/**
 * Builds proposal execution response.
 */
function buildProposalExecutionResponse(proposal: {
  id: string;
  toolName: string;
  status: ToolProposalStatus;
  error: string | null;
}) {
  if (proposal.status === ToolProposalStatus.EXECUTED) {
    return `Approved and executed proposal ${proposal.id} (${proposal.toolName}).`;
  }
  if (proposal.status === ToolProposalStatus.FAILED) {
    return `Approval received for proposal ${proposal.id}, but execution failed: ${proposal.error ?? 'unknown failure'}.`;
  }
  if (proposal.status === ToolProposalStatus.APPROVED) {
    return `Proposal ${proposal.id} was approved.`;
  }
  return `Proposal ${proposal.id} status is ${proposal.status}.`;
}

/**
 * Implements extract proposal id.
 */
function extractProposalId(input: string) {
  const match = input.match(
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i,
  );
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Builds agent auth failure response.
 */
function buildAgentAuthFailureResponse(
  contextHostId: string | undefined,
  authFailureTraces: Array<Record<string, unknown>>,
) {
  const firstTrace = authFailureTraces[0];
  const agentId = typeof firstTrace?.agentId === 'string' ? firstTrace.agentId : 'unknown-agent';
  const statusCode =
    typeof firstTrace?.statusCode === 'number'
      ? firstTrace.statusCode
      : typeof firstTrace?.statusCode === 'string'
        ? Number(firstTrace.statusCode)
        : undefined;
  const statusText = Number.isFinite(statusCode) ? ` (HTTP ${statusCode})` : '';

  const contextText = contextHostId ? ` for host ${contextHostId}` : '';
  return `I could not run read commands${contextText} because MCP auth failed for agent ${agentId}${statusText}. Re-enroll the agent (or rotate agent credentials), wait for heartbeat recovery, then retry your request.`;
}

/**
 * Implements conversation history memory key.
 */
function conversationHistoryMemoryKey(conversationId: string) {
  return `ai_chat_memory_v1:${conversationId}`;
}

/**
 * Parses iso date.
 */
function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Builds unsummarized history filters.
 */
function buildUnsummarizedHistoryFilters(input: {
  cursorMessageId: string | null;
  cursorCreatedAt: Date | null;
  oldestIncludedMessage: { id: string; createdAt: Date } | null;
}): Prisma.AiMessageWhereInput[] {
  const filters: Prisma.AiMessageWhereInput[] = [];

  if (input.cursorMessageId && input.cursorCreatedAt) {
    filters.push({
      OR: [
        { createdAt: { gt: input.cursorCreatedAt } },
        {
          createdAt: input.cursorCreatedAt,
          id: { gt: input.cursorMessageId },
        },
      ],
    });
  }

  if (input.oldestIncludedMessage) {
    filters.push({
      OR: [
        { createdAt: { lt: input.oldestIncludedMessage.createdAt } },
        {
          createdAt: input.oldestIncludedMessage.createdAt,
          id: { lt: input.oldestIncludedMessage.id },
        },
      ],
    });
  }

  return filters;
}

// Parses strict JSON host-summary payloads from model output.
function parseAiHostSummary(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsedJson = JSON.parse(trimmed) as unknown;
    const parsed = aiHostSummarySchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Implements normalize ai summary decimals.
 */
function normalizeAiSummaryDecimals(summary: {
  overview: string[];
  sections: {
    facts: string[];
    containers: string[];
    systemServices: string[];
    storage: string[];
    network: string[];
  };
}) {
  return {
    overview: summary.overview.map((line) => normalizeDecimalText(line)),
    sections: {
      facts: summary.sections.facts.map((line) => normalizeDecimalText(line)),
      containers: summary.sections.containers.map((line) => normalizeDecimalText(line)),
      systemServices: summary.sections.systemServices.map((line) => normalizeDecimalText(line)),
      storage: summary.sections.storage.map((line) => normalizeDecimalText(line)),
      network: summary.sections.network.map((line) => normalizeDecimalText(line)),
    },
  };
}

/**
 * Implements normalize decimal text.
 */
function normalizeDecimalText(text: string) {
  return text.replace(
    /(^|[^\d.])(-?\d+\.\d{3,})(?=($|[^\d.]))/g,
    (_match, prefix: string, raw: string) => {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        return `${prefix}${raw}`;
      }
      const rounded = stripTrailingZeroes(parsed.toFixed(2));
      return `${prefix}${rounded}`;
    },
  );
}

/**
 * Implements strip trailing zeroes.
 */
function stripTrailingZeroes(value: string) {
  if (!value.includes('.')) {
    return value;
  }
  return value.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

/**
 * Implements extract list path.
 */
function extractListPath(message: string) {
  const explicit = message.match(/(?:in|under|at)\s+([~/][\w./-]*)/i)?.[1];
  const fromMessage =
    explicit && explicit.startsWith('~/') ? `/home/${explicit.slice(2)}` : explicit;
  const lower = message.toLowerCase();
  const fallback = lower.includes('/root') ? '/root' : '/home';
  return normalizeListPath(fromMessage ?? fallback);
}

/**
 * Implements normalize list path.
 */
function normalizeListPath(rawPath: string) {
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith('/') || trimmed.includes('..')) {
    return '/home';
  }
  for (const allowedPrefix of ['/home', '/root', '/tmp', '/var/log']) {
    if (trimmed === allowedPrefix || trimmed.startsWith(`${allowedPrefix}/`)) {
      return trimmed;
    }
  }
  return '/home';
}

// Deterministic fallback summary when AI is disabled or parsing fails.
function buildFallbackHostSummary(
  host: {
    id: string;
    hostname: string;
    status: string;
    cpuPct: number;
    memPct: number;
    diskPct: number;
    lastSeenAt: Date | null;
    serviceInstances: Array<{ name: string; status: string; endpoint: string | null }>;
  },
  snapshot: Record<string, unknown> | null,
  factCapturedAt: Date | null,
): HostDetailSummary {
  const factsBullets = [
    `Current host status is ${host.status}.`,
    `Top metrics: CPU ${host.cpuPct.toFixed(1)}%, memory ${host.memPct.toFixed(1)}%, disk ${host.diskPct.toFixed(1)}%.`,
    host.lastSeenAt
      ? `Host last seen at ${host.lastSeenAt.toLocaleString()}.`
      : 'Host has not reported a recent heartbeat timestamp.',
    factCapturedAt
      ? `Latest fact snapshot captured at ${factCapturedAt.toLocaleString()}.`
      : 'No fact snapshot was captured yet.',
  ];

  const overview = [
    `${host.hostname} is currently ${host.status}.`,
    `CPU ${host.cpuPct.toFixed(1)}%, memory ${host.memPct.toFixed(1)}%, disk ${host.diskPct.toFixed(1)}%.`,
    host.serviceInstances.length > 0
      ? `${host.serviceInstances.length} discovered service instance${host.serviceInstances.length === 1 ? '' : 's'} are attached to this host.`
      : 'No discovered service instances are attached to this host yet.',
  ];

  const containersBullets = summarizeContainers(snapshot?.containers, host.serviceInstances);
  const systemServicesBullets = summarizeSystemServices(snapshot?.systemd);
  const storageBullets = summarizeStorage(snapshot?.storage, host.diskPct);
  const networkBullets = summarizeNetwork(snapshot?.network);

  return {
    hostId: host.id,
    hostName: host.hostname,
    generatedAt: new Date().toISOString(),
    generatedByAi: false,
    overview,
    sections: {
      facts: {
        title: 'Facts',
        bullets: factsBullets,
      },
      containers: {
        title: 'Containers',
        bullets: containersBullets,
      },
      systemServices: {
        title: 'System Services',
        bullets: systemServicesBullets,
      },
      storage: {
        title: 'Storage',
        bullets: storageBullets,
      },
      network: {
        title: 'Network',
        bullets: networkBullets,
      },
    },
  };
}

/**
 * Implements summarize containers.
 */
function summarizeContainers(
  containersValue: unknown,
  serviceInstances: Array<{ name: string; status: string; endpoint: string | null }>,
) {
  const containers = normalizeEntryList(containersValue);
  if (containers.length === 0) {
    if (serviceInstances.length === 0) {
      return ['No container telemetry is present in the latest snapshot.'];
    }

    const up = serviceInstances.filter((instance) => instance.status === 'OK').length;
    return [
      `Container telemetry is missing, but ${serviceInstances.length} service instance${serviceInstances.length === 1 ? '' : 's'} are discovered from integrations.`,
      `${up} service instance${up === 1 ? '' : 's'} are currently healthy.`,
    ];
  }

  const running = containers.filter((container) => hasHealthyState(container)).length;
  const unhealthy = containers.length - running;
  const sampleNames = containers
    .map(
      (container) =>
        readString(container, ['name']) ??
        readString(container, ['container']) ??
        readString(container, ['id']),
    )
    .filter((value): value is string => Boolean(value))
    .slice(0, 4);

  return [
    `${containers.length} container record${containers.length === 1 ? '' : 's'} reported in latest snapshot.`,
    `${running} appear healthy/running and ${unhealthy} need attention.`,
    sampleNames.length > 0
      ? `Examples: ${sampleNames.join(', ')}.`
      : 'Container names are not present in the snapshot payload.',
  ];
}

// Snapshot summarizers below convert heterogeneous telemetry JSON into stable,
// readable bullets even when integrations provide partial data.
function summarizeSystemServices(systemdValue: unknown) {
  const services = normalizeEntryList(systemdValue);
  if (services.length === 0) {
    return ['No system service telemetry is present in the latest snapshot.'];
  }

  const active = services.filter((service) => {
    const state = readString(service, ['active']) ?? readString(service, ['state']) ?? '';
    return ['active', 'running'].includes(state.toLowerCase());
  }).length;
  const inactive = services.length - active;
  const failingNames = services
    .filter((service) => {
      const state = (
        readString(service, ['active']) ??
        readString(service, ['state']) ??
        ''
      ).toLowerCase();
      return state.length > 0 && !['active', 'running'].includes(state);
    })
    .map((service) => readString(service, ['name']) ?? readString(service, ['unit']))
    .filter((value): value is string => Boolean(value))
    .slice(0, 3);

  return [
    `${services.length} system service record${services.length === 1 ? '' : 's'} were captured.`,
    `${active} active/running and ${inactive} not active.`,
    failingNames.length > 0
      ? `Services to review: ${failingNames.join(', ')}.`
      : 'No obviously failing services were identified from service state values.',
  ];
}

/**
 * Implements summarize storage.
 */
function summarizeStorage(storageValue: unknown, hostDiskPct: number) {
  const storage = toRecord(storageValue);
  if (!storage) {
    return [
      `Overall disk usage is ${hostDiskPct.toFixed(1)}%.`,
      'Detailed filesystem breakdown is not present in snapshot storage data.',
    ];
  }

  const filesystems = normalizeEntryList(storage.filesystems ?? storage.mounts ?? storage.disks);
  if (filesystems.length === 0) {
    return [
      `Overall disk usage is ${hostDiskPct.toFixed(1)}%.`,
      'No per-filesystem records are available in storage telemetry.',
    ];
  }

  const highUsage = filesystems
    .map((entry) => ({
      name:
        readString(entry, ['mount']) ??
        readString(entry, ['name']) ??
        readString(entry, ['filesystem']) ??
        'unknown',
      pct:
        readNumber(entry, ['usagePct']) ??
        readNumber(entry, ['usedPct']) ??
        readNumber(entry, ['percent']) ??
        null,
    }))
    .filter((entry) => entry.pct !== null && entry.pct >= 80)
    .slice(0, 4);

  return [
    `${filesystems.length} filesystem record${filesystems.length === 1 ? '' : 's'} were reported.`,
    `Host disk metric is ${hostDiskPct.toFixed(1)}%.`,
    highUsage.length > 0
      ? `High usage filesystems: ${highUsage.map((entry) => `${entry.name} (${entry.pct?.toFixed(1)}%)`).join(', ')}.`
      : 'No filesystem usage crossed the 80% threshold in the reported data.',
  ];
}

/**
 * Implements summarize network.
 */
function summarizeNetwork(networkValue: unknown) {
  const network = toRecord(networkValue);
  if (!network) {
    return ['No network telemetry is present in the latest snapshot.'];
  }

  const interfaces = normalizeEntryList(network.interfaces ?? network.ifaces ?? network.adapters);
  if (interfaces.length === 0) {
    return ['Network snapshot has no interface records to summarize.'];
  }

  const up = interfaces.filter((entry) => {
    const state = readString(entry, ['state']) ?? readString(entry, ['status']) ?? '';
    return ['up', 'connected', 'active'].includes(state.toLowerCase());
  }).length;

  const addressExamples = interfaces
    .map(
      (entry) =>
        readString(entry, ['ipv4']) ?? readString(entry, ['address']) ?? readString(entry, ['ip']),
    )
    .filter((value): value is string => Boolean(value))
    .slice(0, 4);

  return [
    `${interfaces.length} interface record${interfaces.length === 1 ? '' : 's'} are present in network telemetry.`,
    `${up} interface${up === 1 ? '' : 's'} currently appear up/connected.`,
    addressExamples.length > 0
      ? `Reported addresses include ${addressExamples.join(', ')}.`
      : 'No interface addresses were found in the current network payload.',
  ];
}

/**
 * Implements normalize entry list.
 */
function normalizeEntryList(value: unknown): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];

  if (Array.isArray(value)) {
    for (const entry of value) {
      const record = toRecord(entry);
      if (record) {
        entries.push(record);
      }
    }
    return entries;
  }

  if (value && typeof value === 'object') {
    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
      const record = toRecord(entry);
      if (!record) {
        continue;
      }
      entries.push({
        name,
        ...record,
      });
    }
  }

  return entries;
}

/**
 * Checks whether healthy state.
 */
function hasHealthyState(entry: Record<string, unknown>) {
  const status = (
    readString(entry, ['status']) ??
    readString(entry, ['state']) ??
    readString(entry, ['health']) ??
    ''
  ).toLowerCase();
  return ['running', 'healthy', 'up', 'ok', 'active'].includes(status);
}

/**
 * Implements read number.
 */
function readNumber(input: Record<string, unknown>, path: string[]): number | null {
  let current: unknown = input;
  for (const key of path) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === 'number' && Number.isFinite(current)) {
    return current;
  }
  if (typeof current === 'string') {
    const parsed = Number(current);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

/**
 * Implements read string.
 */
function readString(input: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = input;
  for (const key of path) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === 'string' && current.trim().length > 0) {
    return current.trim();
  }
  if (typeof current === 'number' || typeof current === 'boolean') {
    return String(current);
  }
  return null;
}

/**
 * Implements to record.
 */
function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
