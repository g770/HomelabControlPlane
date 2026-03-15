/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the vite config logic for the repository.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Prefer TS/TSX source files when both TS and emitted JS exist side-by-side.
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.mts', '.jsx', '.json'],
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@homelab/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@homelab/shared/': path.resolve(__dirname, '../../packages/shared/src/'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
