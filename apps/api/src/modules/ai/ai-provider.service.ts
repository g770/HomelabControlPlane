/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements ai provider service business logic for the service layer.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import OpenAI from 'openai';
import { AuditService } from '../audit/audit.service';
import { SecurityService } from '../common/security.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LOCAL_ADMIN_EMAIL } from '../auth/admin-account';

const AI_PROVIDER_MEMORY_KEY = 'ai_provider_v1';

@Injectable()
/**
 * Implements the ai provider service class.
 */
export class AiProviderService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    private readonly securityService: SecurityService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Gets model.
   */
  getModel() {
    return this.configService.get<string>('OPENAI_MODEL', 'gpt-5-mini');
  }

  /**
   * Gets provider config.
   */
  async getProviderConfig() {
    const record = await this.findStoredConfig();
    const apiKeyEncrypted = readApiKeyEncrypted(record?.value);

    return {
      configured: Boolean(apiKeyEncrypted),
      model: this.getModel(),
      updatedAt: record?.updatedAt?.toISOString() ?? null,
    };
  }

  /**
   * Checks whether configured.
   */
  async isConfigured() {
    const record = await this.findStoredConfig();
    return Boolean(readApiKeyEncrypted(record?.value));
  }

  /**
   * Returns client for the current workflow.
   */
  async getClient(): Promise<OpenAI | null> {
    const apiKey = await this.getApiKey();
    return apiKey ? new OpenAI({ apiKey }) : null;
  }

  /**
   * Sets provider config.
   */
  async setProviderConfig(userId: string, apiKey: string | null) {
    const configOwner = await this.findConfigOwner();
    if (!configOwner) {
      throw new Error('Local admin account not initialized');
    }

    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
    const configured = trimmed.length > 0;
    const apiKeyEncrypted = configured
      ? this.securityService.encryptJson({ apiKey: trimmed })
      : null;

    const saved = await this.prisma.opsMemory.upsert({
      where: {
        userId_key: {
          userId: configOwner.id,
          key: AI_PROVIDER_MEMORY_KEY,
        },
      },
      update: {
        value: {
          apiKeyEncrypted,
        } as Prisma.InputJsonValue,
      },
      create: {
        userId: configOwner.id,
        key: AI_PROVIDER_MEMORY_KEY,
        value: {
          apiKeyEncrypted,
        } as Prisma.InputJsonValue,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'ai.provider.update',
      targetType: 'ops_memory',
      targetId: saved.id,
      paramsJson: {
        configured,
      },
      success: true,
    });

    return {
      configured,
      model: this.getModel(),
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  /**
   * Gets api key.
   */
  private async getApiKey() {
    const record = await this.findStoredConfig();
    const apiKeyEncrypted = readApiKeyEncrypted(record?.value);
    if (!apiKeyEncrypted) {
      return null;
    }

    const decrypted = this.securityService.decryptJson<{ apiKey?: string }>(apiKeyEncrypted);
    const apiKey = typeof decrypted.apiKey === 'string' ? decrypted.apiKey.trim() : '';
    return apiKey.length > 0 ? apiKey : null;
  }

  /**
   * Handles find stored config.
   */
  private async findStoredConfig() {
    const configOwner = await this.findConfigOwner();
    if (!configOwner) {
      return null;
    }

    return this.prisma.opsMemory.findUnique({
      where: {
        userId_key: {
          userId: configOwner.id,
          key: AI_PROVIDER_MEMORY_KEY,
        },
      },
      select: {
        id: true,
        value: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Handles find config owner.
   */
  private findConfigOwner() {
    return this.prisma.user.findUnique({
      where: { email: LOCAL_ADMIN_EMAIL },
      select: {
        id: true,
      },
    });
  }
}

/**
 * Implements read api key encrypted.
 */
function readApiKeyEncrypted(value: Prisma.JsonValue | null | undefined) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = (value as Record<string, unknown>).apiKeyEncrypted;
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : null;
}
