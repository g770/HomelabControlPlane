/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the runtime logger logic for the repository.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { LoggerService } from '@nestjs/common';

/**
 * Describes the runtime log level shape.
 */
export type RuntimeLogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

type LogMeta = Record<string, unknown>;

type RuntimeLoggerOptions = {
  serviceName: string;
  level: RuntimeLogLevel;
  filePath: string;
  logToStdout: boolean;
  logToFile: boolean;
  rotateFileSizeBytes: number;
  retentionDays: number;
  maxBytesPerService: number;
};

const levelOrder: Record<RuntimeLogLevel, number> = {
  error: 10,
  warn: 20,
  info: 30,
  debug: 40,
  trace: 50,
};

const secretKeyMarkers = [
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'credential',
  'sshpass',
];

/**
 * Parses log level.
 */
export function parseLogLevel(
  raw: string | undefined,
  fallback: RuntimeLogLevel = 'info',
): RuntimeLogLevel {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (
    normalized === 'error' ||
    normalized === 'warn' ||
    normalized === 'info' ||
    normalized === 'debug' ||
    normalized === 'trace'
  ) {
    return normalized;
  }
  return fallback;
}

/**
 * Parses booleanish.
 */
function parseBooleanish(raw: string | undefined, fallback: boolean) {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

/**
 * Parses positive integer.
 */
function parsePositiveInteger(raw: string | undefined, fallback: number) {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * Implements format value.
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(redactString(value));
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(redactValue(value));
  } catch {
    return JSON.stringify(String(value));
  }
}

/**
 * Implements redact string.
 */
function redactString(raw: string) {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]');
}

/**
 * Checks whether redact key.
 */
function shouldRedactKey(key: string) {
  const normalized = key.toLowerCase();
  return secretKeyMarkers.some((marker) => normalized.includes(marker));
}

/**
 * Implements redact value.
 */
function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (shouldRedactKey(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = redactValue(entry);
  }
  return output;
}

/**
 * Implements normalize log meta.
 */
function normalizeLogMeta(meta: LogMeta | undefined): LogMeta {
  if (!meta) {
    return {};
  }

  const output: LogMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (shouldRedactKey(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = redactValue(value);
  }
  return output;
}

/**
 * Implements make rotation path.
 */
function makeRotationPath(filePath: string) {
  const directory = dirname(filePath);
  const extension = extname(filePath);
  const base = basename(filePath, extension);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');

  let suffix = 1;
  while (true) {
    const candidate = join(directory, `${base}.${stamp}.${suffix}${extension || '.log'}`);
    if (!existsSync(candidate)) {
      return candidate;
    }
    suffix += 1;
  }
}

/**
 * Implements list managed files.
 */
function listManagedFiles(filePath: string) {
  const directory = dirname(filePath);
  const extension = extname(filePath);
  const fileName = basename(filePath);
  const base = basename(filePath, extension);

  if (!existsSync(directory)) {
    return [] as Array<{ path: string; mtimeMs: number; size: number }>;
  }

  return readdirSync(directory)
    .filter(
      (entry) =>
        entry === fileName ||
        (entry.startsWith(`${base}.`) && (extension ? entry.endsWith(extension) : true)),
    )
    .map((entry) => {
      const target = join(directory, entry);
      const stats = statSync(target);
      return {
        path: target,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      };
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
}

/**
 * Implements the runtime logger class.
 */
export class RuntimeLogger {
  private readonly maintenanceTimer?: NodeJS.Timeout;

  /**
   * Creates the instance and stores the dependencies required by this type.
   */
  constructor(private readonly options: RuntimeLoggerOptions) {
    if (this.options.logToFile) {
      try {
        this.ensureFilePath();
        this.pruneFiles();
      } catch (error) {
        this.writeInternalError('Logger initialization failed', error);
      }
      this.maintenanceTimer = setInterval(
        () => {
          try {
            this.pruneFiles();
          } catch (error) {
            this.writeInternalError('Logger maintenance failed', error);
          }
        },
        60 * 60 * 1000,
      );
      this.maintenanceTimer.unref();
    }
  }

  /**
   * Handles trace.
   */
  trace(message: string, meta?: LogMeta) {
    this.write('trace', message, meta);
  }

  /**
   * Handles debug.
   */
  debug(message: string, meta?: LogMeta) {
    this.write('debug', message, meta);
  }

  /**
   * Handles info.
   */
  info(message: string, meta?: LogMeta) {
    this.write('info', message, meta);
  }

  /**
   * Handles warn.
   */
  warn(message: string, meta?: LogMeta) {
    this.write('warn', message, meta);
  }

  /**
   * Handles error.
   */
  error(message: string, meta?: LogMeta) {
    this.write('error', message, meta);
  }

  /**
   * Handles close.
   */
  close() {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
    }
  }

  /**
   * Checks whether write.
   */
  private shouldWrite(level: RuntimeLogLevel) {
    return levelOrder[level] <= levelOrder[this.options.level];
  }

  /**
   * Handles write.
   */
  private write(level: RuntimeLogLevel, message: string, meta?: LogMeta) {
    if (!this.shouldWrite(level)) {
      return;
    }

    const payload = normalizeLogMeta(meta);
    const segments = [
      new Date().toISOString(),
      `level=${level.toUpperCase()}`,
      `service=${this.options.serviceName}`,
      `msg=${JSON.stringify(redactString(message))}`,
    ];

    for (const [key, value] of Object.entries(payload)) {
      segments.push(`${key}=${formatValue(value)}`);
    }

    const line = `${segments.join(' ')}\n`;
    if (this.options.logToStdout) {
      const output = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      output.write(line);
    }

    if (this.options.logToFile) {
      this.appendToFile(line);
    }
  }

  /**
   * Handles ensure file path.
   */
  private ensureFilePath() {
    const directory = dirname(this.options.filePath);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
    if (!existsSync(this.options.filePath)) {
      appendFileSync(this.options.filePath, '');
    }
  }

  /**
   * Handles append to file.
   */
  private appendToFile(line: string) {
    try {
      this.ensureFilePath();
      this.rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(this.options.filePath, line);
    } catch (error) {
      this.writeInternalError('Failed to append log file', error);
    }
  }

  /**
   * Handles rotate if needed.
   */
  private rotateIfNeeded(nextLineBytes: number) {
    if (!existsSync(this.options.filePath)) {
      return;
    }

    const stats = statSync(this.options.filePath);
    if (stats.size + nextLineBytes < this.options.rotateFileSizeBytes) {
      return;
    }

    const rotatedPath = makeRotationPath(this.options.filePath);
    renameSync(this.options.filePath, rotatedPath);
    appendFileSync(this.options.filePath, '');
    this.pruneFiles();
  }

  /**
   * Handles prune files.
   */
  private pruneFiles() {
    const retentionMs = this.options.retentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const files = listManagedFiles(this.options.filePath);

    for (const entry of files) {
      const ageMs = now - entry.mtimeMs;
      if (ageMs <= retentionMs) {
        continue;
      }
      if (entry.path === this.options.filePath) {
        continue;
      }
      unlinkSync(entry.path);
    }

    const remaining = listManagedFiles(this.options.filePath);
    let totalBytes = remaining.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of remaining) {
      if (totalBytes <= this.options.maxBytesPerService) {
        break;
      }
      if (entry.path === this.options.filePath) {
        continue;
      }
      unlinkSync(entry.path);
      totalBytes -= entry.size;
    }
  }

  /**
   * Handles write internal error.
   */
  private writeInternalError(message: string, error: unknown) {
    const fallback = `${new Date().toISOString()} level=ERROR service=${this.options.serviceName} msg=${JSON.stringify(message)} reason=${JSON.stringify(
      error instanceof Error ? error.message : String(error),
    )}\n`;
    process.stderr.write(fallback);
  }
}

/**
 * Implements default api file path.
 */
function defaultApiFilePath() {
  return process.env.API_LOG_FILE_PATH?.trim() || '/var/log/homelab/api/api.log';
}

/**
 * Builds api runtime logger.
 */
function buildApiRuntimeLogger() {
  const level = parseLogLevel(process.env.API_LOG_LEVEL ?? process.env.LOG_LEVEL, 'info');
  const logToStdout = parseBooleanish(process.env.LOG_TO_STDOUT, true);
  const logToFile = parseBooleanish(process.env.LOG_TO_FILE, true);
  return new RuntimeLogger({
    serviceName: 'api',
    level,
    filePath: defaultApiFilePath(),
    logToStdout,
    logToFile,
    rotateFileSizeBytes: parsePositiveInteger(
      process.env.LOG_ROTATE_FILE_SIZE_BYTES,
      50 * 1024 * 1024,
    ),
    retentionDays: parsePositiveInteger(process.env.LOG_RETENTION_DAYS, 14),
    maxBytesPerService: parsePositiveInteger(
      process.env.LOG_MAX_BYTES_PER_SERVICE,
      1024 * 1024 * 1024,
    ),
  });
}

/**
 * Implements api runtime logger.
 */
export const apiRuntimeLogger = buildApiRuntimeLogger();

/**
 * Implements the nest runtime logger class.
 */
export class NestRuntimeLogger implements LoggerService {
  /**
   * Handles log.
   */
  log(message: unknown, context?: string) {
    apiRuntimeLogger.info(normalizeMessage(message), context ? { context } : undefined);
  }

  /**
   * Handles error.
   */
  error(message: unknown, trace?: string, context?: string) {
    const meta: LogMeta = {};
    if (trace) {
      meta.trace = trace;
    }
    if (context) {
      meta.context = context;
    }
    apiRuntimeLogger.error(normalizeMessage(message), meta);
  }

  /**
   * Handles warn.
   */
  warn(message: unknown, context?: string) {
    apiRuntimeLogger.warn(normalizeMessage(message), context ? { context } : undefined);
  }

  /**
   * Handles debug.
   */
  debug(message: unknown, context?: string) {
    apiRuntimeLogger.debug(normalizeMessage(message), context ? { context } : undefined);
  }

  /**
   * Handles verbose.
   */
  verbose(message: unknown, context?: string) {
    apiRuntimeLogger.trace(normalizeMessage(message), context ? { context } : undefined);
  }

  /**
   * Handles fatal.
   */
  fatal(message: unknown, trace?: string, context?: string) {
    this.error(message, trace, context);
  }
}

/**
 * Implements normalize message.
 */
function normalizeMessage(message: unknown) {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof Error) {
    return message.message;
  }
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}
