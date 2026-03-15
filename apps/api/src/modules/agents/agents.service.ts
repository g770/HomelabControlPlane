/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements agents service business logic for the service layer.
 */
import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Prisma, type RecoveryKeyAlg } from '@prisma/client';
import { randomBytes } from 'crypto';
import {
  agentRecoveryCertificatePurpose,
  buildRecoveryCertificatePayload,
} from '../agent-recovery/agent-recovery.util';
import { AuditService } from '../audit/audit.service';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  extractResolvedPrimaryIp,
  normalizeHostName,
  resolveCanonicalHostByIdentity,
} from '../common/host-identity';
import { SecurityService } from '../common/security.service';
import {
  agentEventsSchema,
  enrollSchema,
  factsSchema,
  heartbeatSchema,
  inventorySchema,
} from './agents.schemas';

/**
 * Describes the agent auth error code shape.
 */
export type AgentAuthErrorCode = 'AGENT_NOT_REGISTERED' | 'AGENT_REVOKED' | 'AGENT_TOKEN_INVALID';

const agentStatusOnline = 'ONLINE';
const agentStatusOffline = 'OFFLINE';
const agentStatusRevoked = 'REVOKED';
const eventSeverityWarn = 'WARN';

class AgentAuthException extends UnauthorizedException {
  /**
   * Creates the instance and stores the dependencies required by this type.
   */
  constructor(message: string, code: AgentAuthErrorCode) {
    super({
      statusCode: 401,
      message,
      code,
    });
  }
}

@Injectable()
/**
 * Implements the agents service class.
 */
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly securityService: SecurityService,
    private readonly eventsService: EventsService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Creates enrollment token.
   */
  async createEnrollmentToken(userId: string, expiresHours: number) {
    const rawToken = randomBytes(24).toString('hex');
    const tokenHash = this.securityService.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + expiresHours * 60 * 60 * 1000);

    const created = await this.prisma.enrollmentToken.create({
      data: {
        tokenHash,
        expiresAt,
        createdByUserId: userId,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'enrollment_token.create',
      targetType: 'enrollment_token',
      paramsJson: { expiresHours },
      success: true,
    });

    return { tokenId: created.id, token: rawToken, expiresAt };
  }

  /**
   * Builds recovery fields for the surrounding workflow.
   */
  private buildRecoveryFields(recoveryPublicKey?: string): {
    recoveryKeyAlg?: RecoveryKeyAlg;
    recoveryKeyFingerprint?: string;
    recoveryPublicKey?: string;
  } {
    if (!recoveryPublicKey) {
      return {};
    }

    const certificatePayload = buildRecoveryCertificatePayload(recoveryPublicKey);
    return {
      recoveryKeyAlg: certificatePayload.keyAlg as RecoveryKeyAlg,
      recoveryKeyFingerprint: certificatePayload.recoveryKeyFingerprint,
      recoveryPublicKey: certificatePayload.recoveryPublicKey,
    };
  }

  /**
   * Handles list enrollment tokens.
   */
  async listEnrollmentTokens() {
    return this.prisma.enrollmentToken.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
        createdBy: {
          select: {
            id: true,
            email: true,
            displayName: true,
          },
        },
      },
    });
  }

  /**
   * Handles revoke enrollment token.
   */
  async revokeEnrollmentToken(tokenId: string, userId: string) {
    await this.prisma.enrollmentToken.update({
      where: { id: tokenId },
      data: { revokedAt: new Date() },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'enrollment_token.revoke',
      targetType: 'enrollment_token',
      targetId: tokenId,
      success: true,
    });

    return { ok: true };
  }

  /**
   * Handles enroll.
   */
  async enroll(input: unknown) {
    const payload = enrollSchema.parse(input);
    const normalizedHostname = normalizeHostName(payload.hostname);
    if (!normalizedHostname) {
      throw new UnauthorizedException('Invalid hostname');
    }

    const tokenHash = this.securityService.hashToken(payload.enrollmentToken);
    const enrollmentToken = await this.prisma.enrollmentToken.findUnique({
      where: { tokenHash },
    });

    if (!enrollmentToken || enrollmentToken.revokedAt || enrollmentToken.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid enrollment token');
    }

    const agentToken = randomBytes(32).toString('hex');
    const agentTokenHash = this.securityService.hashToken(agentToken);
    const recoveryIdentity = this.buildRecoveryIdentity(payload.recoveryPublicKey);

    let host: { id: string };
    let agent: { id: string };
    let enrollMode: 'created' | 'rotated' = 'created';
    try {
      const existingHost = await resolveCanonicalHostByIdentity(this.prisma, this.auditService, {
        hostname: normalizedHostname,
      });

      host = existingHost
        ? await this.prisma.host.update({
            where: { id: existingHost.id },
            data: {
              status: 'OK',
              lastSeenAt: new Date(),
              agentVersion: payload.agentVersion,
              tags: mergeTags(existingHost.tags, payload.tags),
            },
          })
        : await this.prisma.host.create({
            data: {
              hostname: normalizedHostname,
              tags: payload.tags,
              status: 'OK',
              lastSeenAt: new Date(),
              agentVersion: payload.agentVersion,
            },
          });

      const existingAgent = await this.prisma.agent.findUnique({
        where: { hostId: host.id },
        select: { id: true },
      });
      enrollMode = existingAgent ? 'rotated' : 'created';

      agent = await this.prisma.agent.upsert({
        where: { hostId: host.id },
        update: {
          displayName: payload.displayName,
          endpoint: payload.endpoint,
          mcpEndpoint: payload.mcpEndpoint,
          tokenHash: agentTokenHash,
          tokenEncrypted: this.securityService.encryptJson({ token: agentToken }),
          status: agentStatusOnline,
          lastSeenAt: new Date(),
          version: payload.agentVersion,
          ...recoveryIdentity.fields,
          revokedAt: null,
          enrolledAt: new Date(),
        },
        create: {
          hostId: host.id,
          displayName: payload.displayName,
          endpoint: payload.endpoint,
          mcpEndpoint: payload.mcpEndpoint,
          tokenHash: agentTokenHash,
          tokenEncrypted: this.securityService.encryptJson({ token: agentToken }),
          status: agentStatusOnline,
          lastSeenAt: new Date(),
          version: payload.agentVersion,
          ...recoveryIdentity.fields,
        },
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException('Agent enrollment conflict for this host');
      }
      throw error;
    }

    await this.eventsService.emit({
      type: 'agent.enrolled',
      message: `Agent enrolled for ${payload.hostname}`,
      hostId: host.id,
      payload: { agentId: agent.id },
    });

    await this.auditService.write({
      action: 'agent.enroll',
      targetType: 'agent',
      targetId: agent.id,
      paramsJson: { hostname: payload.hostname, enrollMode },
      success: true,
    });

    return {
      agentId: agent.id,
      agentToken,
      recoveryCertificate: recoveryIdentity.certificate,
    };
  }

  /**
   * Handles verify agent token.
   */
  async verifyAgentToken(agentId: string, bearerToken: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      throw new AgentAuthException('Agent not registered', 'AGENT_NOT_REGISTERED');
    }
    if (agent.revokedAt) {
      throw new AgentAuthException('Agent revoked', 'AGENT_REVOKED');
    }

    const providedHash = this.securityService.hashToken(bearerToken);
    if (!this.securityService.constantTimeEquals(providedHash, agent.tokenHash)) {
      throw new AgentAuthException('Invalid agent token', 'AGENT_TOKEN_INVALID');
    }

    return agent;
  }

  /**
   * Handles heartbeat.
   */
  async heartbeat(agentId: string, bearerToken: string, input: unknown) {
    const payload = heartbeatSchema.parse(input);
    const agent = await this.verifyAgentToken(agentId, bearerToken);
    const recoveryIdentity = payload.recoveryPublicKey
      ? this.buildRecoveryIdentity(payload.recoveryPublicKey)
      : payload.recoveryCertificateMissing && agent.recoveryPublicKey
        ? this.buildRecoveryIdentity(agent.recoveryPublicKey)
        : null;

    await this.prisma.agent.update({
      where: { id: agent.id },
      data: {
        status: payload.status === 'ONLINE' ? agentStatusOnline : agentStatusOffline,
        lastSeenAt: new Date(),
        capabilities: payload.capabilities as Prisma.InputJsonValue,
        version: payload.version,
        ...(payload.recoveryPublicKey ? (recoveryIdentity?.fields ?? {}) : {}),
      },
    });

    if (agent.hostId) {
      await this.prisma.host.update({
        where: { id: agent.hostId },
        data: { lastSeenAt: new Date(), status: 'OK', agentVersion: payload.version },
      });
    }

    return {
      ok: true,
      recoveryCertificate: recoveryIdentity?.certificate,
    };
  }

  /**
   * Handles facts.
   */
  async facts(agentId: string, bearerToken: string, input: unknown) {
    const payload = factsSchema.parse(input);
    const agent = await this.verifyAgentToken(agentId, bearerToken);
    const normalizedHostname = normalizeHostName(payload.hostname);
    const resolvedPrimaryIp = extractResolvedPrimaryIp(payload.snapshot);
    const existingHost = await resolveCanonicalHostByIdentity(
      this.prisma,
      this.auditService,
      {
        hostId: agent.hostId,
        hostname: normalizedHostname,
        primaryIp: resolvedPrimaryIp,
      },
      {
        actorAgentId: agent.id,
        preferredCanonicalHostId: agent.hostId,
      },
    );

    const host = existingHost
      ? await this.prisma.host.update({
          where: { id: existingHost.id },
          data: {
            cpuPct: payload.cpuPct,
            memPct: payload.memPct,
            diskPct: payload.diskPct,
            lastSeenAt: new Date(),
            status: 'OK',
            agentVersion: payload.agentVersion,
            resolvedPrimaryIp,
            tags: mergeTags(existingHost.tags, payload.tags),
          },
        })
      : await this.prisma.host.create({
          data: {
            hostname: normalizedHostname ?? payload.hostname,
            resolvedPrimaryIp,
            tags: payload.tags,
            cpuPct: payload.cpuPct,
            memPct: payload.memPct,
            diskPct: payload.diskPct,
            lastSeenAt: new Date(),
            status: 'OK',
            agentVersion: payload.agentVersion,
          },
        });

    await this.prisma.agent.update({
      where: { id: agent.id },
      data: { hostId: host.id, lastSeenAt: new Date(), status: agentStatusOnline },
    });

    await this.prisma.hostFact.create({
      data: {
        hostId: host.id,
        snapshot: payload.snapshot as Prisma.InputJsonValue,
      },
    });

    await this.eventsService.emit({
      type: 'host.facts',
      message: `Host facts updated for ${payload.hostname}`,
      hostId: host.id,
      payload: {
        cpuPct: payload.cpuPct,
        memPct: payload.memPct,
        diskPct: payload.diskPct,
      },
    });

    return { ok: true };
  }

  /**
   * Handles inventory.
   */
  async inventory(agentId: string, bearerToken: string, input: unknown) {
    const payload = inventorySchema.parse(input);
    const agent = await this.verifyAgentToken(agentId, bearerToken);

    const host = await this.prisma.host.findUnique({ where: { id: agent.hostId ?? undefined } });
    if (!host) {
      throw new NotFoundException('Host not linked to agent');
    }

    const source = `agent:${agent.id}`;

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const serviceItem of payload.services) {
        const service = await tx.service.upsert({
          where: { name_source: { name: serviceItem.name, source } },
          update: {
            status: serviceItem.status,
            tags: host.tags,
          },
          create: {
            name: serviceItem.name,
            source,
            status: serviceItem.status,
            tags: host.tags,
          },
        });

        await tx.serviceInstance.upsert({
          where: {
            serviceId_hostId_name: {
              serviceId: service.id,
              hostId: host.id,
              name: `${serviceItem.name}@${host.hostname}`,
            },
          },
          update: {
            name: `${serviceItem.name}@${host.hostname}`,
            status: serviceItem.status,
            endpoint: serviceItem.endpoint,
            metadata: serviceItem.metadata as Prisma.InputJsonValue | undefined,
            lastSeenAt: new Date(),
            hostId: host.id,
          },
          create: {
            serviceId: service.id,
            hostId: host.id,
            name: `${serviceItem.name}@${host.hostname}`,
            status: serviceItem.status,
            endpoint: serviceItem.endpoint,
            metadata: serviceItem.metadata as Prisma.InputJsonValue | undefined,
            lastSeenAt: new Date(),
          },
        });
      }
    });

    await this.eventsService.emit({
      type: 'host.inventory',
      message: `Inventory updated for ${host.hostname}`,
      hostId: host.id,
      payload: {
        services: payload.services.length,
        containers: payload.containers.length,
        systemdFailed: payload.systemd.failedCount,
      },
    });

    return { ok: true };
  }

  /**
   * Handles ingest events.
   */
  async ingestEvents(agentId: string, bearerToken: string, input: unknown) {
    const payload = agentEventsSchema.parse(input);
    const agent = await this.verifyAgentToken(agentId, bearerToken);

    const hostId = agent.hostId ?? undefined;

    await Promise.all(
      payload.events.map((event) =>
        this.eventsService.emit({
          type: event.type,
          message: event.message,
          severity: event.severity,
          hostId,
          payload: event.payload as Prisma.InputJsonValue | undefined,
        }),
      ),
    );

    return { accepted: payload.events.length };
  }

  /**
   * Handles list agents.
   */
  async listAgents() {
    return this.prisma.agent.findMany({
      orderBy: { enrolledAt: 'desc' },
      select: {
        id: true,
        hostId: true,
        displayName: true,
        endpoint: true,
        mcpEndpoint: true,
        capabilities: true,
        lastSeenAt: true,
        status: true,
        version: true,
        enrolledAt: true,
        revokedAt: true,
        host: {
          select: {
            id: true,
            hostname: true,
            status: true,
            tags: true,
          },
        },
      },
    });
  }

  /**
   * Gets agent.
   */
  async getAgent(agentId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        hostId: true,
        displayName: true,
        endpoint: true,
        mcpEndpoint: true,
        capabilities: true,
        lastSeenAt: true,
        status: true,
        version: true,
        enrolledAt: true,
        revokedAt: true,
        host: {
          select: {
            id: true,
            hostname: true,
            status: true,
            tags: true,
          },
        },
      },
    });

    if (!agent) {
      throw new NotFoundException('Agent not found');
    }

    return agent;
  }

  /**
   * Handles revoke.
   */
  async revoke(agentId: string, actorUserId: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }

    if (agent.revokedAt) {
      await this.auditService.write({
        actorUserId,
        action: 'agent.revoke',
        targetType: 'agent',
        targetId: agentId,
        resultJson: {
          alreadyRevoked: true,
        } as Prisma.InputJsonValue,
        success: true,
      });
      return { ok: true, alreadyRevoked: true };
    }

    await this.prisma.agent.update({
      where: { id: agentId },
      data: { revokedAt: new Date(), status: agentStatusRevoked },
    });

    await this.eventsService.emit({
      type: 'agent.revoked',
      message: `Agent ${agentId} revoked`,
      hostId: agent.hostId ?? undefined,
      severity: eventSeverityWarn,
    });

    await this.auditService.write({
      actorUserId,
      action: 'agent.revoke',
      targetType: 'agent',
      targetId: agentId,
      resultJson: {
        alreadyRevoked: false,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return { ok: true, alreadyRevoked: false };
  }

  /**
   * Handles delete revoked.
   */
  async deleteRevoked(agentId: string, actorUserId: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }

    if (!agent.revokedAt) {
      throw new ConflictException('Agent must be revoked before deletion');
    }

    await this.prisma.agent.delete({
      where: { id: agentId },
    });

    await this.eventsService.emit({
      type: 'agent.deleted',
      message: `Agent ${agentId} deleted`,
      hostId: agent.hostId ?? undefined,
      severity: eventSeverityWarn,
    });

    await this.auditService.write({
      actorUserId,
      action: 'agent.delete',
      targetType: 'agent',
      targetId: agentId,
      success: true,
    });

    return { ok: true };
  }

  /**
   * Parses bearer token.
   */
  parseBearerToken(header?: string) {
    if (!header) {
      throw new AgentAuthException('Missing authorization', 'AGENT_TOKEN_INVALID');
    }

    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new AgentAuthException('Invalid authorization header', 'AGENT_TOKEN_INVALID');
    }

    return token;
  }

  /**
   * Builds recovery identity.
   */
  private buildRecoveryIdentity(recoveryPublicKey?: string) {
    if (!recoveryPublicKey) {
      return {
        certificate: null as string | null,
        fields: this.buildRecoveryFields(),
      };
    }

    const certificatePayload = buildRecoveryCertificatePayload(recoveryPublicKey);
    return {
      certificate: this.securityService.signOpaqueJson(
        agentRecoveryCertificatePurpose,
        certificatePayload,
      ),
      fields: this.buildRecoveryFields(recoveryPublicKey),
    };
  }

  async syncServicesFromIntegration(
    hostName: string,
    services: Array<{ name: string; status: 'OK' | 'WARN' | 'CRIT' | 'UNKNOWN'; tags?: string[] }>,
    source: string,
  ) {
    const normalizedHostname = normalizeHostName(hostName) ?? hostName;
    const existingHost = await resolveCanonicalHostByIdentity(this.prisma, this.auditService, {
      hostname: normalizedHostname,
    });
    const host = existingHost
      ? await this.prisma.host.update({
          where: { id: existingHost.id },
          data: { lastSeenAt: new Date() },
        })
      : await this.prisma.host.create({
          data: {
            hostname: normalizedHostname,
            tags: [],
            lastSeenAt: new Date(),
            status: 'UNKNOWN',
          },
        });

    await this.prisma.$transaction(
      services.map((service) =>
        this.prisma.service.upsert({
          where: { name_source: { name: service.name, source } },
          update: { status: service.status, tags: service.tags ?? [] },
          create: {
            name: service.name,
            source,
            status: service.status,
            tags: service.tags ?? [],
          },
        }),
      ),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    return host.id;
  }
}

/**
 * Checks whether prisma unique constraint error.
 */
function isPrismaUniqueConstraintError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}

/**
 * Implements merge tags.
 */
function mergeTags(current: string[], next: string[]) {
  return Array.from(
    new Set([...current, ...next].map((tag) => tag.trim()).filter((tag) => tag.length > 0)),
  );
}
