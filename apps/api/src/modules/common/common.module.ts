/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the common module providers and dependencies.
 */
import { Global, Module } from '@nestjs/common';
import { SecurityService } from './security.service';

@Global()
@Module({
  providers: [SecurityService],
  exports: [SecurityService],
})
/**
 * Implements the common module class.
 */
export class CommonModule {}
