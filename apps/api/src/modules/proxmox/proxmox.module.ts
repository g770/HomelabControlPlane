/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the proxmox module providers and dependencies.
 */
import { Module } from '@nestjs/common';
import { ProxmoxController } from './proxmox.controller';
import { ProxmoxService } from './proxmox.service';

@Module({
  controllers: [ProxmoxController],
  providers: [ProxmoxService],
  exports: [ProxmoxService],
})
/**
 * Implements the proxmox module class.
 */
export class ProxmoxModule {}
