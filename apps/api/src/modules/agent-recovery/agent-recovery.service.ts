/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements agent recovery service business logic for the service layer.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { EventsService } from '../events/events.service';
import {
  agentRecoveryCertificatePurpose,
  agentRecoveryChallengePurpose,
  buildRecoveryCertificatePayload,
  buildRecoveryChallengePayload,
  buildRecoveryClaimMessage,
  normalizeRecoveryPublicKey,
  type RecoveryChallengePayload,
  type RecoveryCertificatePayload,
  verifyRecoverySignature,
} from './agent-recovery.util';
import { PrismaService } from '../../prisma/prisma.service';
import {
  normalizeHostName,
  normalizePrimaryIp,
  resolveCanonicalHostByIdentity,
} from '../common/host-identity';
import { SecurityService } from '../common/security.service';
import { agentRecoverySummaryResponseSchema } from '@homelab/shared';
import type {
  AgentRecoveryClaimPoll,
  ApproveAgentRecoveryClaim,
  DenyAgentRecoveryClaim,
  SubmitAgentRecoveryClaim,
} from './agent-recovery.schemas';

const agentRecoveryClaimSelect = {
  id: true,
  recoveryKeyAlg: true,
  recoveryKeyFingerprint: true,
  hostname: true,
  primaryIp: true,
  displayName: true,
  endpoint: true,
  mcpEndpoint: true,
  agentVersion: true,
  tags: true,
  status: true,
  denialReason: true,
  firstSeenAt: true,
  lastSeenAt: true,
  approvedAt: true,
  deniedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  agent: {
    select: {
      id: true,
      hostId: true,
      status: true,
      revokedAt: true,
    },
  },
  approvedBy: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
  deniedBy: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
} satisfies Prisma.AgentRecoveryClaimSelect;

type AgentRecoveryClaimStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED_PENDING_AGENT'
  | 'DENIED'
  | 'COMPLETED';

const recoveryClaimStatusPendingApproval: AgentRecoveryClaimStatus = 'PENDING_APPROVAL';
const recoveryClaimStatusApprovedPendingAgent: AgentRecoveryClaimStatus = 'APPROVED_PENDING_AGENT';
const recoveryClaimStatusDenied: AgentRecoveryClaimStatus = 'DENIED';
const recoveryClaimStatusCompleted: AgentRecoveryClaimStatus = 'COMPLETED';
const agentStatusOffline = 'OFFLINE';

@Injectable()
/**
 * Implements the agent recovery service class.
 */
export class AgentRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly securityService: SecurityService,
    private readonly auditService: AuditService,
    private readonly eventsService: EventsService,
  ) {}

  /**
   * Creates challenge.
   */
  createChallenge() {
    const payload = buildRecoveryChallengePayload();
    return {
      challengeToken: this.securityService.signOpaqueJson(agentRecoveryChallengePurpose, payload),
      expiresAt: payload.expiresAt,
    };
  }

  /**
   * Handles submit claim.
   */
  async submitClaim(input: SubmitAgentRecoveryClaim) {
    const payload = {
      ...input,
      hostname: normalizeHostName(input.hostname) ?? input.hostname,
      primaryIp: normalizePrimaryIp(input.primaryIp),
      displayName: input.displayName?.trim() || null,
      agentVersion: input.agentVersion?.trim() || null,
      tags: normalizeTags(input.tags),
    };
    if (!payload.hostname.trim()) {
      throw new BadRequestException('Hostname is required');
    }

    const challenge = this.verifyChallenge(payload.challengeToken);
    const certificate = this.verifyCertificate(payload.recoveryCertificate);
    const message = buildRecoveryClaimMessage({
      challengeToken: payload.challengeToken,
      hostname: payload.hostname,
      primaryIp: payload.primaryIp,
      displayName: payload.displayName,
      endpoint: payload.endpoint,
      mcpEndpoint: payload.mcpEndpoint,
      agentVersion: payload.agentVersion,
      tags: payload.tags,
    });
    if (!verifyRecoverySignature(certificate.recoveryPublicKey, message, payload.signature)) {
      throw new UnauthorizedException('Invalid recovery signature');
    }

    const pollToken = randomBytes(24).toString('hex');
    const existing = await this.prisma.agentRecoveryClaim.findUnique({
      where: { recoveryKeyFingerprint: certificate.recoveryKeyFingerprint },
    });
    const preserveApprovedState =
      existing?.status === recoveryClaimStatusApprovedPendingAgent &&
      Boolean(existing.approvedCredentialsEncrypted);

    const claim = existing
      ? await this.prisma.agentRecoveryClaim.update({
          where: { id: existing.id },
          data: {
            recoveryKeyAlg: certificate.keyAlg,
            recoveryPublicKey: certificate.recoveryPublicKey,
            hostname: payload.hostname,
            primaryIp: payload.primaryIp,
            displayName: payload.displayName,
            endpoint: payload.endpoint,
            mcpEndpoint: payload.mcpEndpoint,
            agentVersion: payload.agentVersion,
            tags: payload.tags,
            pollTokenHash: this.securityService.hashToken(pollToken),
            lastSeenAt: new Date(),
            status: preserveApprovedState
              ? recoveryClaimStatusApprovedPendingAgent
              : recoveryClaimStatusPendingApproval,
            ...(preserveApprovedState
              ? {}
              : {
                  approvedCredentialsEncrypted: null,
                  denialReason: null,
                  agentId: null,
                  approvedByUserId: null,
                  deniedByUserId: null,
                  approvedAt: null,
                  deniedAt: null,
                  completedAt: null,
                }),
          },
        })
      : await this.prisma.agentRecoveryClaim.create({
          data: {
            recoveryKeyAlg: certificate.keyAlg,
            recoveryKeyFingerprint: certificate.recoveryKeyFingerprint,
            recoveryPublicKey: certificate.recoveryPublicKey,
            hostname: payload.hostname,
            primaryIp: payload.primaryIp,
            displayName: payload.displayName,
            endpoint: payload.endpoint,
            mcpEndpoint: payload.mcpEndpoint,
            agentVersion: payload.agentVersion,
            tags: payload.tags,
            pollTokenHash: this.securityService.hashToken(pollToken),
            status: recoveryClaimStatusPendingApproval,
            firstSeenAt: new Date(challenge.issuedAt),
            lastSeenAt: new Date(),
          },
        });

    await this.auditService.write({
      action: 'agent.recovery.claim_submit',
      targetType: 'agent_recovery_claim',
      targetId: claim.id,
      paramsJson: {
        recoveryKeyFingerprint: certificate.recoveryKeyFingerprint,
        hostname: payload.hostname,
        primaryIp: payload.primaryIp,
        status: claim.status,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return {
      claimId: claim.id,
      pollToken,
      status: claim.status,
    };
  }

  /**
   * Handles status.
   */
  async status(claimId: string, input: AgentRecoveryClaimPoll) {
    const claim = await this.requireClaimWithPollToken(claimId, input.pollToken);
    if (claim.status === recoveryClaimStatusApprovedPendingAgent) {
      if (!claim.approvedCredentialsEncrypted) {
        throw new ConflictException('Approved credentials are not available for this claim');
      }
      return {
        status: claim.status,
        ...this.securityService.decryptJson<{
          agentId: string;
          agentToken: string;
          recoveryCertificate: string;
        }>(claim.approvedCredentialsEncrypted),
      };
    }
    if (claim.status === recoveryClaimStatusDenied) {
      return {
        status: claim.status,
        reason: claim.denialReason ?? 'Claim denied',
      };
    }
    return { status: claim.status };
  }

  /**
   * Handles ack.
   */
  async ack(claimId: string, input: AgentRecoveryClaimPoll) {
    const claim = await this.requireClaimWithPollToken(claimId, input.pollToken);
    if (claim.status === recoveryClaimStatusCompleted) {
      return { ok: true, alreadyCompleted: true };
    }
    if (claim.status !== recoveryClaimStatusApprovedPendingAgent) {
      throw new ConflictException('Claim is not awaiting agent acknowledgment');
    }

    await this.prisma.agentRecoveryClaim.update({
      where: { id: claim.id },
      data: {
        status: recoveryClaimStatusCompleted,
        completedAt: new Date(),
        pollTokenHash: null,
        approvedCredentialsEncrypted: null,
      },
    });

    await this.auditService.write({
      action: 'agent.recovery.complete',
      targetType: 'agent_recovery_claim',
      targetId: claim.id,
      paramsJson: {
        agentId: claim.agentId,
      } as Prisma.InputJsonValue,
      success: true,
    });

    await this.eventsService.emit({
      type: 'agent.recovery.completed',
      message: `Agent recovery completed for ${claim.hostname}`,
      hostId: undefined,
      payload: {
        agentId: claim.agentId,
        recoveryKeyFingerprint: claim.recoveryKeyFingerprint,
      } as Prisma.InputJsonValue,
    });

    return { ok: true, alreadyCompleted: false };
  }

  /**
   * Handles list claims.
   */
  async listClaims(status?: AgentRecoveryClaimStatus) {
    const claims = await this.prisma.agentRecoveryClaim.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
      select: agentRecoveryClaimSelect,
    });
    return { claims };
  }

  /**
   * Gets summary.
   */
  async getSummary() {
    const pendingClaims = await this.prisma.agentRecoveryClaim.findMany({
      where: { status: recoveryClaimStatusPendingApproval },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        displayName: true,
        hostname: true,
        lastSeenAt: true,
      },
    });

    const pendingApprovalFingerprint =
      pendingClaims.length > 0 ? fingerprintPendingRecoveryClaims(pendingClaims) : null;

    return agentRecoverySummaryResponseSchema.parse({
      pendingApprovalCount: pendingClaims.length,
      pendingApprovalFingerprint,
      pendingClaimsPreview: pendingClaims.slice(0, 5).map((claim) => ({
        id: claim.id,
        label: summarizeRecoveryClaimLabel(claim),
        hostname: claim.hostname,
        lastSeenAt: claim.lastSeenAt.toISOString(),
      })),
    });
  }

  /**
   * Gets claim.
   */
  async getClaim(claimId: string) {
    const claim = await this.prisma.agentRecoveryClaim.findUnique({
      where: { id: claimId },
      select: agentRecoveryClaimSelect,
    });
    if (!claim) {
      throw new NotFoundException('Agent recovery claim not found');
    }
    return claim;
  }

  /**
   * Handles approve claim.
   */
  async approveClaim(claimId: string, userId: string, _body: ApproveAgentRecoveryClaim) {
    void _body;
    const claim = await this.prisma.agentRecoveryClaim.findUnique({
      where: { id: claimId },
    });
    if (!claim) {
      throw new NotFoundException('Agent recovery claim not found');
    }
    if (claim.status === recoveryClaimStatusDenied) {
      throw new ConflictException('Denied claim cannot be approved');
    }
    if (claim.status === recoveryClaimStatusCompleted) {
      return this.getClaim(claimId);
    }

    const host = await this.resolveOrCreateHost(claim);
    const hostAgent = await this.prisma.agent.findUnique({
      where: { hostId: host.id },
    });
    if (
      hostAgent &&
      hostAgent.recoveryKeyFingerprint &&
      hostAgent.recoveryKeyFingerprint !== claim.recoveryKeyFingerprint &&
      !hostAgent.revokedAt
    ) {
      throw new ConflictException('Host is already linked to another active agent');
    }

    const certificatePayload = buildRecoveryCertificatePayload(claim.recoveryPublicKey);
    const recoveryCertificate = this.securityService.signOpaqueJson(
      agentRecoveryCertificatePurpose,
      certificatePayload,
    );
    const agentToken = randomBytes(32).toString('hex');
    const tokenHash = this.securityService.hashToken(agentToken);
    const existingAgent = await this.prisma.agent.findFirst({
      where: {
        OR: [{ recoveryKeyFingerprint: claim.recoveryKeyFingerprint }, { hostId: host.id }],
      },
    });

    const agent = existingAgent
      ? await this.prisma.agent.update({
          where: { id: existingAgent.id },
          data: {
            hostId: host.id,
            displayName: claim.displayName,
            endpoint: claim.endpoint,
            mcpEndpoint: claim.mcpEndpoint,
            tokenHash,
            tokenEncrypted: this.securityService.encryptJson({ token: agentToken }),
            recoveryKeyAlg: claim.recoveryKeyAlg,
            recoveryKeyFingerprint: claim.recoveryKeyFingerprint,
            recoveryPublicKey: claim.recoveryPublicKey,
            status: agentStatusOffline,
            version: claim.agentVersion,
            revokedAt: null,
            enrolledAt: new Date(),
          },
        })
      : await this.prisma.agent.create({
          data: {
            hostId: host.id,
            displayName: claim.displayName,
            endpoint: claim.endpoint,
            mcpEndpoint: claim.mcpEndpoint,
            tokenHash,
            tokenEncrypted: this.securityService.encryptJson({ token: agentToken }),
            recoveryKeyAlg: claim.recoveryKeyAlg,
            recoveryKeyFingerprint: claim.recoveryKeyFingerprint,
            recoveryPublicKey: claim.recoveryPublicKey,
            status: agentStatusOffline,
            version: claim.agentVersion,
          },
        });

    await this.prisma.agentRecoveryClaim.update({
      where: { id: claim.id },
      data: {
        status: recoveryClaimStatusApprovedPendingAgent,
        approvedCredentialsEncrypted: this.securityService.encryptJson({
          agentId: agent.id,
          agentToken,
          recoveryCertificate,
        }),
        agentId: agent.id,
        approvedByUserId: userId,
        approvedAt: new Date(),
        deniedByUserId: null,
        deniedAt: null,
        denialReason: null,
        completedAt: null,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'agent.recovery.approve',
      targetType: 'agent_recovery_claim',
      targetId: claim.id,
      paramsJson: {
        recoveryKeyFingerprint: claim.recoveryKeyFingerprint,
        agentId: agent.id,
        hostId: host.id,
      } as Prisma.InputJsonValue,
      success: true,
    });

    await this.eventsService.emit({
      type: 'agent.recovery.approved',
      message: `Agent recovery approved for ${claim.hostname}`,
      hostId: host.id,
      payload: {
        agentId: agent.id,
        recoveryKeyFingerprint: claim.recoveryKeyFingerprint,
      } as Prisma.InputJsonValue,
    });

    return this.getClaim(claim.id);
  }

  /**
   * Handles deny claim.
   */
  async denyClaim(claimId: string, userId: string, body: DenyAgentRecoveryClaim) {
    const claim = await this.prisma.agentRecoveryClaim.findUnique({
      where: { id: claimId },
    });
    if (!claim) {
      throw new NotFoundException('Agent recovery claim not found');
    }
    if (claim.status === recoveryClaimStatusCompleted) {
      throw new ConflictException('Completed claim cannot be denied');
    }
    if (claim.status === recoveryClaimStatusDenied) {
      return this.getClaim(claimId);
    }

    await this.prisma.agentRecoveryClaim.update({
      where: { id: claim.id },
      data: {
        status: recoveryClaimStatusDenied,
        denialReason: body.reason.trim(),
        deniedByUserId: userId,
        deniedAt: new Date(),
        approvedByUserId: null,
        approvedAt: null,
        agentId: null,
        approvedCredentialsEncrypted: null,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'agent.recovery.deny',
      targetType: 'agent_recovery_claim',
      targetId: claim.id,
      paramsJson: {
        recoveryKeyFingerprint: claim.recoveryKeyFingerprint,
        reason: body.reason.trim(),
      } as Prisma.InputJsonValue,
      success: true,
    });

    return this.getClaim(claim.id);
  }

  /**
   * Handles verify challenge.
   */
  private verifyChallenge(challengeToken: string) {
    let challenge: RecoveryChallengePayload;
    try {
      challenge = this.securityService.verifyOpaqueJson<RecoveryChallengePayload>(
        agentRecoveryChallengePurpose,
        challengeToken,
      );
    } catch (error) {
      throw new UnauthorizedException(
        error instanceof Error ? error.message : 'Invalid challenge token',
      );
    }

    if (challenge.typ !== 'agent-recovery-challenge') {
      throw new UnauthorizedException('Invalid challenge token type');
    }
    if (new Date(challenge.expiresAt).getTime() < Date.now()) {
      throw new UnauthorizedException('Expired challenge token');
    }
    return challenge;
  }

  /**
   * Handles verify certificate.
   */
  private verifyCertificate(recoveryCertificate: string) {
    let certificate: RecoveryCertificatePayload;
    try {
      certificate = this.securityService.verifyOpaqueJson<RecoveryCertificatePayload>(
        agentRecoveryCertificatePurpose,
        recoveryCertificate,
      );
    } catch (error) {
      throw new UnauthorizedException(
        error instanceof Error ? error.message : 'Invalid recovery certificate',
      );
    }

    if (certificate.typ !== 'agent-recovery-certificate') {
      throw new UnauthorizedException('Invalid recovery certificate type');
    }
    const normalized = normalizeRecoveryPublicKey(certificate.recoveryPublicKey);
    if (
      certificate.recoveryKeyFingerprint !==
      buildRecoveryCertificatePayload(normalized).recoveryKeyFingerprint
    ) {
      throw new UnauthorizedException('Recovery certificate fingerprint mismatch');
    }
    return {
      ...certificate,
      recoveryPublicKey: normalized,
    };
  }

  /**
   * Handles require claim with poll token.
   */
  private async requireClaimWithPollToken(claimId: string, pollToken: string) {
    const claim = await this.prisma.agentRecoveryClaim.findUnique({
      where: { id: claimId },
    });
    if (!claim) {
      throw new NotFoundException('Agent recovery claim not found');
    }
    if (!claim.pollTokenHash) {
      throw new UnauthorizedException('Missing poll token for claim');
    }

    const pollTokenHash = this.securityService.hashToken(pollToken);
    if (!this.securityService.constantTimeEquals(pollTokenHash, claim.pollTokenHash)) {
      throw new UnauthorizedException('Invalid poll token');
    }
    return claim;
  }

  private async resolveOrCreateHost(claim: {
    hostname: string;
    primaryIp: string | null;
    tags: string[];
    agentVersion: string | null;
  }) {
    const normalizedHostname = normalizeHostName(claim.hostname) ?? claim.hostname;
    const existingHost = await resolveCanonicalHostByIdentity(this.prisma, this.auditService, {
      hostname: normalizedHostname,
      primaryIp: claim.primaryIp,
    });
    if (existingHost) {
      return this.prisma.host.update({
        where: { id: existingHost.id },
        data: {
          tags: mergeTags(existingHost.tags, claim.tags),
          resolvedPrimaryIp: claim.primaryIp ?? existingHost.resolvedPrimaryIp ?? null,
          agentVersion: claim.agentVersion,
        },
      });
    }

    return this.prisma.host.create({
      data: {
        hostname: normalizedHostname,
        resolvedPrimaryIp: claim.primaryIp,
        tags: claim.tags,
        status: 'UNKNOWN',
        agentVersion: claim.agentVersion,
      },
    });
  }
}

/**
 * Implements normalize tags.
 */
function normalizeTags(tags: string[]) {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)));
}

/**
 * Implements merge tags.
 */
function mergeTags(current: string[], next: string[]) {
  return Array.from(
    new Set([...current, ...next].map((tag) => tag.trim()).filter((tag) => tag.length > 0)),
  );
}

/**
 * Implements summarize recovery claim label.
 */
function summarizeRecoveryClaimLabel(claim: {
  displayName: string | null;
  hostname: string;
  id: string;
}) {
  const displayName = claim.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  const hostname = claim.hostname.trim();
  if (hostname) {
    return hostname;
  }
  return claim.id;
}

/**
 * Implements fingerprint pending recovery claims.
 */
function fingerprintPendingRecoveryClaims(
  claims: Array<{
    id: string;
    lastSeenAt: Date;
  }>,
) {
  const canonical = claims
    .map((claim) => `${claim.id}:${claim.lastSeenAt.toISOString()}`)
    .sort()
    .join('\n');
  return hashText(canonical);
}

/**
 * Checks whether hash text.
 */
function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
