/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes proxmox controller request handling for the API service.
 */
import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { proxmoxGuestActionRequestSchema, type ProxmoxGuestActionRequest } from '@homelab/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ProxmoxService } from './proxmox.service';

@Controller('proxmox')
/**
 * Implements the proxmox controller class.
 */
export class ProxmoxController {
  constructor(private readonly proxmoxService: ProxmoxService) {}

  @Get('integrations')
  /**
   * Handles list integrations.
   */
  listIntegrations() {
    return this.proxmoxService.listIntegrations();
  }

  @Get('integrations/:integrationId/guests')
  listGuests(
    @Param('integrationId') integrationId: string,
    @Query('kind') kind?: string,
    @Query('powerState') powerState?: string,
    @Query('status') status?: string,
    @Query('node') node?: string,
    @Query('search') search?: string,
  ) {
    return this.proxmoxService.listGuests(integrationId, {
      kind,
      status: powerState ?? status,
      node,
      search,
    });
  }

  @Get('integrations/:integrationId/guests/:kind/:vmid')
  getGuestDetail(
    @Param('integrationId') integrationId: string,
    @Param('kind') kind: string,
    @Param('vmid') vmid: string,
  ) {
    return this.proxmoxService.getGuestDetail(integrationId, parseGuestKind(kind), parseVmid(vmid));
  }

  @Get('integrations/:integrationId/guests/:kind/:vmid/tasks')
  listGuestTasks(
    @Param('integrationId') integrationId: string,
    @Param('kind') kind: string,
    @Param('vmid') vmid: string,
    @Query('limit') limit?: string,
  ) {
    return this.proxmoxService.listGuestTasks(
      integrationId,
      parseGuestKind(kind),
      parseVmid(vmid),
      limit,
    );
  }

  @Post('integrations/:integrationId/guests/:kind/:vmid/actions/:action')
  performGuestAction(
    @CurrentUser() user: { sub: string },
    @Param('integrationId') integrationId: string,
    @Param('kind') kind: string,
    @Param('vmid') vmid: string,
    @Param('action') action: string,
    @Body(new ZodValidationPipe(proxmoxGuestActionRequestSchema)) _body: ProxmoxGuestActionRequest,
  ) {
    void _body;
    return this.proxmoxService.performGuestAction(
      user.sub,
      integrationId,
      parseGuestKind(kind),
      parseVmid(vmid),
      parseGuestAction(action),
    );
  }
}

/**
 * Parses guest kind.
 */
function parseGuestKind(value: string) {
  if (value === 'qemu' || value === 'lxc') {
    return value;
  }
  throw new BadRequestException('Unsupported Proxmox guest kind');
}

/**
 * Parses guest action.
 */
function parseGuestAction(value: string) {
  if (value === 'start' || value === 'shutdown' || value === 'stop' || value === 'reboot') {
    return value;
  }
  throw new BadRequestException('Unsupported Proxmox guest action');
}

/**
 * Parses vmid.
 */
function parseVmid(value: string) {
  const vmid = Number(value);
  if (!Number.isInteger(vmid) || vmid < 1) {
    throw new BadRequestException('Invalid Proxmox VMID');
  }
  return vmid;
}
