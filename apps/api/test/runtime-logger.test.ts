/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the runtime logger test behavior.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeLogger, parseLogLevel } from '../src/modules/common/runtime-logger';

const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('runtime logger', () => {
  it('parses supported log levels', () => {
    expect(parseLogLevel('TRACE')).toBe('trace');
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('nope', 'error')).toBe('error');
  });

  it('filters messages below configured threshold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-runtime-logger-'));
    cleanupDirs.push(dir);
    const filePath = join(dir, 'api.log');

    const logger = new RuntimeLogger({
      serviceName: 'api',
      level: 'warn',
      filePath,
      logToStdout: false,
      logToFile: true,
      rotateFileSizeBytes: 1024,
      retentionDays: 14,
      maxBytesPerService: 1024 * 1024,
    });

    logger.info('ignored info log');
    logger.warn('important warning');
    logger.close();

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('important warning');
    expect(content).not.toContain('ignored info log');
  });

  it('redacts sensitive keys and bearer strings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-runtime-logger-'));
    cleanupDirs.push(dir);
    const filePath = join(dir, 'api.log');

    const logger = new RuntimeLogger({
      serviceName: 'api',
      level: 'trace',
      filePath,
      logToStdout: false,
      logToFile: true,
      rotateFileSizeBytes: 1024,
      retentionDays: 14,
      maxBytesPerService: 1024 * 1024,
    });

    logger.info('login attempt', {
      password: 'super-secret',
      note: 'Bearer abc.def.ghi',
      nested: {
        apiToken: 'token-value',
      },
    });
    logger.close();

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('super-secret');
    expect(content).not.toContain('token-value');
    expect(content).not.toContain('abc.def.ghi');
  });

  it('rotates log file when size threshold is exceeded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-runtime-logger-'));
    cleanupDirs.push(dir);
    const filePath = join(dir, 'api.log');

    const logger = new RuntimeLogger({
      serviceName: 'api',
      level: 'info',
      filePath,
      logToStdout: false,
      logToFile: true,
      rotateFileSizeBytes: 120,
      retentionDays: 14,
      maxBytesPerService: 1024 * 1024,
    });

    logger.info('message one that is intentionally long to trigger rotation quickly', { seq: 1 });
    logger.info('message two that is intentionally long to trigger rotation quickly', { seq: 2 });
    logger.close();

    const files = readdirSync(dir);
    expect(files.some((name) => name.startsWith('api.') && name.endsWith('.log'))).toBe(true);
    expect(files).toContain('api.log');
  });
});
