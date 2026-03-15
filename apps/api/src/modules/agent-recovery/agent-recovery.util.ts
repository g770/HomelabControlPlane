/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This utility module provides agent recovery util helpers for the surrounding feature.
 */
import { createHash, createPublicKey, randomBytes, verify } from 'crypto';

/**
 * Implements agent recovery key algorithm.
 */
export const agentRecoveryKeyAlgorithm = 'ED25519' as const;
/**
 * Implements agent recovery certificate purpose.
 */
export const agentRecoveryCertificatePurpose = 'agent-recovery-certificate';
/**
 * Implements agent recovery challenge purpose.
 */
export const agentRecoveryChallengePurpose = 'agent-recovery-challenge';

/**
 * Describes the recovery certificate payload shape.
 */
export type RecoveryCertificatePayload = {
  typ: 'agent-recovery-certificate';
  keyAlg: typeof agentRecoveryKeyAlgorithm;
  recoveryPublicKey: string;
  recoveryKeyFingerprint: string;
  issuedAt: string;
};

/**
 * Describes the recovery challenge payload shape.
 */
export type RecoveryChallengePayload = {
  typ: 'agent-recovery-challenge';
  nonce: string;
  issuedAt: string;
  expiresAt: string;
};

/**
 * Describes the recovery claim signature input shape.
 */
export type RecoveryClaimSignatureInput = {
  challengeToken: string;
  hostname: string;
  primaryIp?: string | null;
  displayName?: string | null;
  endpoint: string;
  mcpEndpoint: string;
  agentVersion?: string | null;
  tags: string[];
};

/**
 * Builds recovery certificate payload.
 */
export function buildRecoveryCertificatePayload(
  recoveryPublicKey: string,
): RecoveryCertificatePayload {
  const normalized = normalizeRecoveryPublicKey(recoveryPublicKey);
  return {
    typ: 'agent-recovery-certificate',
    keyAlg: agentRecoveryKeyAlgorithm,
    recoveryPublicKey: normalized,
    recoveryKeyFingerprint: buildRecoveryKeyFingerprint(normalized),
    issuedAt: new Date().toISOString(),
  };
}

/**
 * Builds recovery challenge payload.
 */
export function buildRecoveryChallengePayload(ttlSec = 60): RecoveryChallengePayload {
  const issuedAt = new Date();
  return {
    typ: 'agent-recovery-challenge',
    nonce: cryptoRandomNonce(),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlSec * 1000).toISOString(),
  };
}

/**
 * Implements normalize recovery public key.
 */
export function normalizeRecoveryPublicKey(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Recovery public key is required');
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, 'base64');
  } catch {
    throw new Error('Recovery public key must be base64');
  }

  if (decoded.length !== 32) {
    throw new Error('Recovery public key must be a 32-byte Ed25519 key');
  }

  return decoded.toString('base64');
}

/**
 * Builds recovery key fingerprint.
 */
export function buildRecoveryKeyFingerprint(recoveryPublicKey: string) {
  const normalized = normalizeRecoveryPublicKey(recoveryPublicKey);
  return createHash('sha256').update(Buffer.from(normalized, 'base64')).digest('hex');
}

/**
 * Implements verify recovery signature.
 */
export function verifyRecoverySignature(
  recoveryPublicKey: string,
  message: string,
  signature: string,
) {
  const publicKey = normalizeRecoveryPublicKey(recoveryPublicKey);
  const signatureBytes = Buffer.from(signature, 'base64');
  const keyObject = createPublicKey({
    key: {
      crv: 'Ed25519',
      kty: 'OKP',
      x: Buffer.from(publicKey, 'base64').toString('base64url'),
    },
    format: 'jwk',
  });

  return verify(null, Buffer.from(message, 'utf8'), keyObject, signatureBytes);
}

/**
 * Builds recovery claim message.
 */
export function buildRecoveryClaimMessage(input: RecoveryClaimSignatureInput) {
  return [
    'agent-recovery-claim:v1',
    input.challengeToken.trim(),
    input.hostname.trim(),
    (input.primaryIp ?? '').trim(),
    (input.displayName ?? '').trim(),
    input.endpoint.trim(),
    input.mcpEndpoint.trim(),
    (input.agentVersion ?? '').trim(),
    JSON.stringify(input.tags ?? []),
  ].join('\n');
}

/**
 * Implements crypto random nonce.
 */
function cryptoRandomNonce() {
  return randomBytes(24).toString('hex');
}
