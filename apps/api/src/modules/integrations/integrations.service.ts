/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements integrations service business logic for the service layer.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { IntegrationUpsert } from '@homelab/shared';
import { IntegrationType } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { EventsService } from '../events/events.service';
import { normalizeHostName, resolveCanonicalHostByIdentity } from '../common/host-identity';
import { SecurityService } from '../common/security.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { IntegrationAdapter } from './integration-adapter';
import { buildIntegrationSource, deleteIntegrationWithAudit } from './integration-cleanup';
import { ProxmoxAdapter } from './proxmox.adapter';
import { readString, toRecord } from './proxmox.client';
import {
  buildStoredProxmoxConfig,
  buildStoredProxmoxCredentials,
  readProxmoxTokenId,
} from './proxmox.integration';

@Injectable()
/**
 * Implements the integrations service class.
 */
export class IntegrationsService {
  private readonly adapters: Partial<Record<IntegrationType, IntegrationAdapter>> = {
    PROXMOX: new ProxmoxAdapter(),
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly securityService: SecurityService,
    private readonly eventsService: EventsService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Handles list.
   */
  async list() {
    const integrations = await this.prisma.integration.findMany({
      where: { type: IntegrationType.PROXMOX },
      include: { credential: true },
      orderBy: { createdAt: 'desc' },
    });

    return integrations.map((integration) => this.toIntegrationSummary(integration));
  }

  /**
   * Creates or update.
   */
  async createOrUpdate(userId: string, body: IntegrationUpsert) {
    const existing = body.id
      ? await this.prisma.integration.findUnique({
          where: { id: body.id },
          include: { credential: true },
        })
      : null;

    if (body.id && (!existing || existing.type !== IntegrationType.PROXMOX)) {
      throw new NotFoundException('Integration not found');
    }

    const nextCredentials = this.buildStoredCredentials(body, existing?.credential?.encryptedBlob);
    const encrypted = this.securityService.encryptJson(nextCredentials);
    const config = buildStoredProxmoxConfig({
      baseUrl: body.baseUrl,
      allowInsecureTls: body.allowInsecureTls,
    });

    const integration = existing
      ? await this.prisma.integration.update({
          where: { id: existing.id },
          data: {
            name: body.name,
            type: IntegrationType.PROXMOX,
            enabled: body.enabled,
            config: config as Prisma.InputJsonValue,
            credential: {
              upsert: {
                create: { encryptedBlob: encrypted },
                update: { encryptedBlob: encrypted },
              },
            },
          },
          include: { credential: true },
        })
      : await this.prisma.integration.create({
          data: {
            name: body.name,
            type: IntegrationType.PROXMOX,
            enabled: body.enabled,
            config: config as Prisma.InputJsonValue,
            credential: {
              create: { encryptedBlob: encrypted },
            },
          },
          include: { credential: true },
        });

    await this.auditService.write({
      actorUserId: userId,
      action: 'integration.upsert',
      targetType: 'integration',
      targetId: integration.id,
      paramsJson: {
        name: body.name,
        baseUrl: body.baseUrl,
        allowInsecureTls: body.allowInsecureTls,
        enabled: body.enabled,
        apiTokenId: body.apiTokenId,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return this.toIntegrationSummary(integration, nextCredentials);
  }

  /**
   * Handles test.
   */
  async test(userId: string, integrationId: string) {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
      include: { credential: true },
    });

    if (!integration || !integration.credential || integration.type !== IntegrationType.PROXMOX) {
      throw new NotFoundException('Integration not found');
    }

    const credentials = this.securityService.decryptJson<Record<string, unknown>>(
      integration.credential.encryptedBlob,
    );
    const adapter = this.requireAdapter(integration.type);
    const result = await adapter.test(integrationConfigToRecord(integration.config), credentials);

    await this.auditService.write({
      actorUserId: userId,
      action: 'integration.test',
      targetType: 'integration',
      targetId: integration.id,
      resultJson: { ok: result.ok, details: result.details } as Prisma.InputJsonValue,
      success: result.ok,
    });

    return result;
  }

  /**
   * Handles sync.
   */
  async sync(userId: string | undefined, integrationId: string) {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
      include: { credential: true },
    });

    if (!integration || !integration.credential || integration.type !== IntegrationType.PROXMOX) {
      throw new NotFoundException('Integration not found');
    }

    const credentials = this.securityService.decryptJson<Record<string, unknown>>(
      integration.credential.encryptedBlob,
    );
    const adapter = this.requireAdapter(integration.type);
    const records = await adapter.sync(integrationConfigToRecord(integration.config), credentials);

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const record of records) {
        const normalizedHostname = normalizeHostName(record.hostName) ?? record.hostName;
        const existingHost = await resolveCanonicalHostByIdentity(tx, this.auditService, {
          hostname: normalizedHostname,
        });
        const host = existingHost
          ? await tx.host.update({
              where: { id: existingHost.id },
              data: {
                lastSeenAt: new Date(),
                status: record.status,
                tags: mergeTags(existingHost.tags, record.tags ?? []),
              },
            })
          : await tx.host.create({
              data: {
                hostname: normalizedHostname,
                status: record.status,
                tags: record.tags ?? [],
                lastSeenAt: new Date(),
              },
            });

        const service = await tx.service.upsert({
          where: {
            name_source: {
              name: record.serviceName,
              source: buildIntegrationSource(integration.type, integration.id),
            },
          },
          update: {
            status: record.status,
            tags: record.tags ?? [],
          },
          create: {
            name: record.serviceName,
            source: buildIntegrationSource(integration.type, integration.id),
            status: record.status,
            tags: record.tags ?? [],
          },
        });

        await tx.serviceInstance.upsert({
          where: {
            serviceId_hostId_name: {
              serviceId: service.id,
              hostId: host.id,
              name: `${service.name}@${host.hostname}`,
            },
          },
          update: {
            status: record.status,
            metadata: { integration: integration.type } as Prisma.InputJsonValue,
            lastSeenAt: new Date(),
          },
          create: {
            serviceId: service.id,
            hostId: host.id,
            name: `${service.name}@${host.hostname}`,
            status: record.status,
            endpoint: null,
            metadata: { integration: integration.type } as Prisma.InputJsonValue,
            lastSeenAt: new Date(),
          },
        });
      }

      await tx.integration.update({
        where: { id: integration.id },
        data: {
          lastSyncAt: new Date(),
          lastStatus: 'ok',
          lastError: null,
        },
      });
    });

    await this.eventsService.emit({
      type: 'integration.sync',
      message: `Integration ${integration.name} synced ${records.length} records`,
      payload: { integrationId: integration.id, count: records.length },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'integration.sync',
      targetType: 'integration',
      targetId: integration.id,
      resultJson: { count: records.length },
      success: true,
    });

    return { ok: true as const, count: records.length };
  }

  /**
   * Handles sync all enabled.
   */
  async syncAllEnabled() {
    const integrations = await this.prisma.integration.findMany({
      where: {
        enabled: true,
        type: IntegrationType.PROXMOX,
      },
      include: { credential: true },
    });

    const results = [];

    for (const integration of integrations) {
      try {
        const result = await this.sync(undefined, integration.id);
        results.push({ id: integration.id, ...result });
      } catch (error) {
        await this.prisma.integration.update({
          where: { id: integration.id },
          data: {
            lastSyncAt: new Date(),
            lastStatus: 'error',
            lastError: error instanceof Error ? error.message : 'unknown error',
          },
        });

        results.push({
          id: integration.id,
          ok: false,
          error: error instanceof Error ? error.message : 'unknown error',
        });
      }
    }

    return results;
  }

  /**
   * Handles remove.
   */
  async remove(userId: string, integrationId: string) {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
      select: {
        id: true,
        type: true,
      },
    });

    if (!integration || integration.type !== IntegrationType.PROXMOX) {
      throw new NotFoundException('Integration not found');
    }

    return deleteIntegrationWithAudit(this.prisma, this.auditService, {
      integrationId: integration.id,
      integrationType: integration.type,
      actorUserId: userId,
      action: 'integration.delete',
    });
  }

  /**
   * Handles require adapter.
   */
  private requireAdapter(type: IntegrationType) {
    const adapter = this.adapters[type];
    if (!adapter) {
      throw new NotFoundException(`No adapter for integration type ${type}`);
    }
    return adapter;
  }

  private toIntegrationSummary(
    integration: {
      id: string;
      name: string;
      type: IntegrationType;
      enabled: boolean;
      config: Prisma.JsonValue;
      credential?: { encryptedBlob: string } | null;
      lastSyncAt: Date | null;
      lastStatus: string | null;
      lastError: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
    credentials?: Record<string, unknown>,
  ) {
    const config = integrationConfigToRecord(integration.config);
    const decryptedCredentials =
      credentials ??
      (integration.credential
        ? this.securityService.decryptJson<Record<string, unknown>>(
            integration.credential.encryptedBlob,
          )
        : undefined);

    return {
      id: integration.id,
      name: integration.name,
      type: 'PROXMOX' as const,
      enabled: integration.enabled,
      baseUrl: readString(config.baseUrl) ?? '',
      allowInsecureTls: readBooleanFlag(config.allowInsecureTls),
      apiTokenId: decryptedCredentials ? readProxmoxTokenId(decryptedCredentials) : null,
      hasApiTokenSecret: decryptedCredentials ? hasSecret(decryptedCredentials) : false,
      lastSyncAt: integration.lastSyncAt?.toISOString() ?? null,
      lastStatus: integration.lastStatus,
      lastError: integration.lastError,
      createdAt: integration.createdAt.toISOString(),
      updatedAt: integration.updatedAt.toISOString(),
    };
  }

  /**
   * Builds stored credentials.
   */
  private buildStoredCredentials(body: IntegrationUpsert, existingEncryptedBlob?: string | null) {
    const trimmedSecret = body.apiTokenSecret?.trim() ?? '';
    if (trimmedSecret.length > 0) {
      return {
        ...buildStoredProxmoxCredentials({
          apiTokenId: body.apiTokenId,
          apiTokenSecret: trimmedSecret,
        }),
      } satisfies Record<string, unknown>;
    }

    if (!existingEncryptedBlob) {
      throw new BadRequestException('API Token Secret is required when creating an integration.');
    }

    const existingCredentials =
      this.securityService.decryptJson<Record<string, unknown>>(existingEncryptedBlob);
    const existingTokenId = readProxmoxTokenId(existingCredentials);
    if (existingTokenId !== body.apiTokenId) {
      throw new BadRequestException('API Token Secret is required when changing the API Token ID.');
    }

    return existingCredentials;
  }
}

/**
 * Implements integration config to record.
 */
function integrationConfigToRecord(config: Prisma.JsonValue) {
  return toRecord(config) ?? {};
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
 * Implements read boolean flag.
 */
function readBooleanFlag(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return false;
}

/**
 * Checks whether secret.
 */
function hasSecret(credentials: Record<string, unknown>) {
  if (typeof credentials.apiToken === 'string' && credentials.apiToken.trim().length > 0) {
    return true;
  }

  return (
    typeof credentials.apiTokenSecret === 'string' && credentials.apiTokenSecret.trim().length > 0
  );
}
