#!/usr/bin/env node
/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the ensure node 22 logic for the repository.
 */
const minimumMajor = 22;
const raw = process.versions.node ?? '0.0.0';
const [majorText] = raw.split('.');
const major = Number(majorText);

if (!Number.isFinite(major) || major < minimumMajor) {
  console.error(
    `Coverage commands require Node ${minimumMajor}+; detected ${raw}. Switch runtimes before running test:coverage.`,
  );
  process.exit(1);
}
