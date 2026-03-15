/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the runtime logger test behavior.
 */
import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeLogger, parseLogLevel } from '../src/runtime-logger';

const cleanupDirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(async () => {
  process.env = { ...originalEnv };
  for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

beforeEach(() => {
  process.env = { ...originalEnv };
});

describe('worker runtime logger', () => {
  it('accepts known log levels and falls back safely', () => {
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('TRACE')).toBe('trace');
    expect(parseLogLevel('invalid', 'warn')).toBe('warn');
  });

  it('writes redacted logs to file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-runtime-logger-'));
    cleanupDirs.push(dir);
    const filePath = join(dir, 'worker.log');

    const logger = new RuntimeLogger({
      serviceName: 'worker',
      level: 'trace',
      filePath,
      logToStdout: false,
      logToFile: true,
      rotateFileSizeBytes: 1024,
      retentionDays: 14,
      maxBytesPerService: 1024 * 1024,
    });

    logger.info('processing queued task', {
      authToken: 'abc123',
      cookie: 'session=xyz',
      details: {
        nestedSecret: 'value',
      },
    });
    logger.close();

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('processing queued task');
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('abc123');
    expect(content).not.toContain('session=xyz');
    expect(content).not.toContain('value');
  });

  it('skips writes below the configured log level', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-runtime-logger-'));
    cleanupDirs.push(dir);
    const filePath = join(dir, 'worker.log');

    const logger = new RuntimeLogger({
      serviceName: 'worker',
      level: 'warn',
      filePath,
      logToStdout: false,
      logToFile: true,
      rotateFileSizeBytes: 1024,
      retentionDays: 14,
      maxBytesPerService: 1024 * 1024,
    });

    logger.info('hidden');
    logger.warn('visible');
    logger.close();

    const content = readFileSync(filePath, 'utf8');
    expect(content).not.toContain('hidden');
    expect(content).toContain('visible');
  });

  it('rotates and prunes old files when thresholds are exceeded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-runtime-logger-'));
    cleanupDirs.push(dir);
    const filePath = join(dir, 'worker.log');
    const rotatedFilePath = join(dir, 'worker.20000101-000000.1.log');

    writeFileSync(rotatedFilePath, 'legacy entry\n');
    const staleTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(rotatedFilePath, staleTime, staleTime);

    const logger = new RuntimeLogger({
      serviceName: 'worker',
      level: 'trace',
      filePath,
      logToStdout: false,
      logToFile: true,
      rotateFileSizeBytes: 32,
      retentionDays: 1,
      maxBytesPerService: 16,
    });

    logger.info('012345678901234567890123456789');
    logger.info('abcdef');
    logger.close();

    const managedFiles = readdirSync(dir).sort();
    expect(managedFiles).toContain('worker.log');
    expect(managedFiles).not.toContain('worker.20000101-000000.1.log');
    expect(
      managedFiles.filter((entry) => entry.startsWith('worker.') && entry.endsWith('.log')),
    ).toHaveLength(1);
  });

  it('reports append failures to stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-runtime-logger-'));
    cleanupDirs.push(dir);
    const blockingParent = join(dir, 'not-a-directory');
    writeFileSync(blockingParent, 'occupied');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const logger = new RuntimeLogger({
      serviceName: 'worker',
      level: 'trace',
      filePath: join(blockingParent, 'worker.log'),
      logToStdout: false,
      logToFile: true,
      rotateFileSizeBytes: 1024,
      retentionDays: 14,
      maxBytesPerService: 1024 * 1024,
    });

    logger.error('will fail');
    logger.close();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to append log file'));
  });

  it('builds the default logger from environment overrides', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-runtime-logger-'));
    cleanupDirs.push(dir);
    const filePath = join(dir, 'env.log');

    process.env.WORKER_LOG_FILE_PATH = filePath;
    process.env.WORKER_LOG_LEVEL = 'trace';
    process.env.LOG_TO_STDOUT = 'off';
    process.env.LOG_TO_FILE = 'yes';
    process.env.LOG_ROTATE_FILE_SIZE_BYTES = 'bad-value';
    process.env.LOG_RETENTION_DAYS = '3';
    process.env.LOG_MAX_BYTES_PER_SERVICE = '2048';

    vi.resetModules();
    const { workerRuntimeLogger } = await import('../src/runtime-logger');

    workerRuntimeLogger.trace('from env', { authToken: 'secret-token' });
    workerRuntimeLogger.close();

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('from env');
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('secret-token');
  });
});
