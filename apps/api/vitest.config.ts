/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the vitest config logic for the repository.
 */
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: '../../coverage/api',
      include: [
        'src/modules/agent-install/**/*.ts',
        'src/modules/agents/**/*.ts',
        'src/modules/ai/**/*.ts',
        'src/modules/common/**/*.ts',
        'src/modules/service-discovery/**/*.ts',
        'src/modules/users/**/*.ts',
      ],
      exclude: ['**/*.module.ts', '**/*.schema.ts', '**/*.schemas.ts', '**/main.ts', '**/*.d.ts'],
      thresholds: {
        // Ratcheted baseline gate; raise as additional API modules gain tests.
        lines: 43,
        functions: 52,
        statements: 43,
        branches: 70,
      },
    },
  },
  resolve: {
    alias: [
      {
        find: '@homelab/shared',
        replacement: path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      },
      {
        find: /^@homelab\/shared\/(.*)$/,
        replacement: path.resolve(__dirname, '../../packages/shared/src/$1'),
      },
    ],
  },
});
