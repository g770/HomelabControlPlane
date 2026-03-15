/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the vitest config logic for the repository.
 */
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.mts', '.jsx', '.json'],
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@homelab/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@homelab/shared/': path.resolve(__dirname, '../../packages/shared/src/'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: '../../coverage/web',
      // Gate currently tracks the utility/component surfaces with dedicated unit tests.
      include: [
        'src/lib/discovery-subnets.ts',
        'src/lib/service-discovery.ts',
        'src/lib/service-state.ts',
        'src/lib/ui-theme.ts',
        'src/components/protected-route.tsx',
      ],
      exclude: ['src/main.tsx', '**/*.d.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
