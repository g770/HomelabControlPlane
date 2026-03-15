/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements security service business logic for the service layer.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

type EncryptedPayload = {
  iv: string;
  authTag: string;
  ciphertext: string;
};

@Injectable()
/**
 * Implements the security service class.
 */
export class SecurityService {
  private readonly key: Buffer;

  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {
    const masterKey = this.configService.getOrThrow<string>('APP_MASTER_KEY');
    this.key = createHash('sha256').update(masterKey).digest();
  }

  /**
   * Implements the hash token workflow for this file.
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Implements the constant time equals workflow for this file.
   */
  constantTimeEquals(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) {
      return false;
    }

    return timingSafeEqual(ba, bb);
  }

  /**
   * Implements the encrypt json workflow for this file.
   */
  encryptJson(input: Record<string, unknown>): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(input));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const payload: EncryptedPayload = {
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };

    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  decryptJson<T extends Record<string, unknown>>(encrypted: string): T {
    const raw = JSON.parse(Buffer.from(encrypted, 'base64').toString('utf8')) as EncryptedPayload;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(raw.iv, 'base64'));

    decipher.setAuthTag(Buffer.from(raw.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(raw.ciphertext, 'base64')),
      decipher.final(),
    ]);

    return JSON.parse(plaintext.toString('utf8')) as T;
  }

  /**
   * Implements the sign opaque json workflow for this file.
   */
  signOpaqueJson(purpose: string, input: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(input), 'utf8').toString('base64url');
    const signature = this.signOpaquePayload(purpose, payload);
    return `${payload}.${signature}`;
  }

  verifyOpaqueJson<T extends Record<string, unknown>>(purpose: string, token: string): T {
    const [payload, signature, ...extra] = token.split('.');
    if (!payload || !signature || extra.length > 0) {
      throw new Error('Invalid signed token format');
    }

    const expectedSignature = this.signOpaquePayload(purpose, payload);
    const actualBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new Error('Invalid signed token signature');
    }

    const raw = Buffer.from(payload, 'base64url').toString('utf8');
    return JSON.parse(raw) as T;
  }

  /**
   * Implements the sign opaque payload workflow for this file.
   */
  private signOpaquePayload(purpose: string, payload: string): string {
    return createHmac('sha256', this.key)
      .update(purpose, 'utf8')
      .update('\n', 'utf8')
      .update(payload, 'utf8')
      .digest('base64url');
  }
}
