/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the dev with logging logic for the repository.
 */
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
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

const logLevelOrder = {
  error: 10,
  warn: 20,
  info: 30,
  debug: 40,
  trace: 50,
};

/**
 * Parses log level.
 */
function parseLogLevel(raw, fallback = 'info') {
  const normalized = String(raw ?? '')
    .trim()
    .toLowerCase();
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
 * Parses bool.
 */
function parseBool(raw, fallback) {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

/**
 * Parses positive.
 */
function parsePositive(raw, fallback) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * Implements redact.
 */
function redact(raw) {
  return String(raw)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]');
}

/**
 * Checks whether emit.
 */
function shouldEmit(level, threshold) {
  return logLevelOrder[level] <= logLevelOrder[threshold];
}

/**
 * Implements list managed files.
 */
function listManagedFiles(filePath) {
  const directory = dirname(filePath);
  const extension = extname(filePath);
  const fileName = basename(filePath);
  const base = basename(filePath, extension);
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter(
      (entry) =>
        entry === fileName ||
        (entry.startsWith(`${base}.`) && (extension ? entry.endsWith(extension) : true)),
    )
    .map((entry) => {
      const path = join(directory, entry);
      const stats = statSync(path);
      return {
        path,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      };
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
}

/**
 * Implements rotate path.
 */
function rotatePath(filePath) {
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
 * Implements prune logs.
 */
function pruneLogs({ filePath, retentionDays, maxBytesPerService }) {
  const now = Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const files = listManagedFiles(filePath);

  for (const file of files) {
    if (file.path === filePath) {
      continue;
    }
    if (now - file.mtimeMs > retentionMs) {
      unlinkSync(file.path);
    }
  }

  const remaining = listManagedFiles(filePath);
  let totalBytes = remaining.reduce((sum, file) => sum + file.size, 0);
  for (const file of remaining) {
    if (totalBytes <= maxBytesPerService) {
      break;
    }
    if (file.path === filePath) {
      continue;
    }
    unlinkSync(file.path);
    totalBytes -= file.size;
  }
}

/**
 * Implements write log.
 */
function writeLog({ filePath, line, rotateFileSizeBytes, retentionDays, maxBytesPerService }) {
  const directory = dirname(filePath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  if (!existsSync(filePath)) {
    appendFileSync(filePath, '');
  }

  const bytes = Buffer.byteLength(line);
  const currentSize = statSync(filePath).size;
  if (currentSize + bytes >= rotateFileSizeBytes) {
    renameSync(filePath, rotatePath(filePath));
    appendFileSync(filePath, '');
  }

  appendFileSync(filePath, line);
  pruneLogs({ filePath, retentionDays, maxBytesPerService });
}

/**
 * Implements classify level.
 */
function classifyLevel(line, source) {
  const normalized = line.toLowerCase();
  if (source === 'stderr') {
    if (normalized.includes('warn')) {
      return 'warn';
    }
    return 'error';
  }
  if (normalized.includes('error')) {
    return 'error';
  }
  if (normalized.includes('warn')) {
    return 'warn';
  }
  if (normalized.includes('debug')) {
    return 'debug';
  }
  return 'info';
}

const level = parseLogLevel(process.env.WEB_LOG_LEVEL ?? process.env.LOG_LEVEL, 'info');
const logToStdout = parseBool(process.env.LOG_TO_STDOUT, true);
const logToFile = parseBool(process.env.LOG_TO_FILE, true);
const filePath = (process.env.WEB_LOG_FILE_PATH ?? '/var/log/homelab/web/web.log').trim();
const rotateFileSizeBytes = parsePositive(process.env.LOG_ROTATE_FILE_SIZE_BYTES, 50 * 1024 * 1024);
const retentionDays = parsePositive(process.env.LOG_RETENTION_DAYS, 14);
const maxBytesPerService = parsePositive(process.env.LOG_MAX_BYTES_PER_SERVICE, 1024 * 1024 * 1024);

const child = spawn('pnpm', ['--filter', '@homelab/web', 'dev'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
});

/**
 * Handles line.
 */
const handleLine = (line, source) => {
  const levelForLine = classifyLevel(line, source);
  if (!shouldEmit(levelForLine, level)) {
    return;
  }

  const redacted = redact(line);
  const formatted = `${new Date().toISOString()} level=${levelForLine.toUpperCase()} service=web msg=${JSON.stringify(redacted)}\n`;
  if (logToStdout) {
    const output =
      levelForLine === 'error' || levelForLine === 'warn' ? process.stderr : process.stdout;
    output.write(formatted);
  }
  if (logToFile) {
    try {
      writeLog({
        filePath,
        line: formatted,
        rotateFileSizeBytes,
        retentionDays,
        maxBytesPerService,
      });
    } catch (error) {
      process.stderr.write(
        `${new Date().toISOString()} level=ERROR service=web msg=${JSON.stringify('Failed to write log file')} reason=${JSON.stringify(String(error))}\n`,
      );
    }
  }
};

createInterface({ input: child.stdout }).on('line', (line) => handleLine(line, 'stdout'));
createInterface({ input: child.stderr }).on('line', (line) => handleLine(line, 'stderr'));

child.on('exit', (code, signal) => {
  const status = code === null ? `signal=${signal ?? 'null'}` : `code=${code}`;
  handleLine(`vite process exited (${status})`, code === 0 ? 'stdout' : 'stderr');
  if (code === null) {
    process.exit(1);
  }
  process.exit(code);
});
