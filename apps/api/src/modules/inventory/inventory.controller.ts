/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes inventory controller request handling for the API service.
 */
import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { hostMetadataUpdateSchema, type HostMetadataUpdate } from '@homelab/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { InventoryService } from './inventory.service';

@Controller()
/**
 * Implements the inventory controller class.
 */
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('home/summary')
  /**
   * Handles home summary.
   */
  homeSummary() {
    return this.inventoryService.homeSummary();
  }

  @Get('hosts')
  /**
   * Handles list hosts.
   */
  listHosts() {
    return this.inventoryService.listHosts();
  }

  @Get('hosts/:id')
  /**
   * Gets host.
   */
  getHost(@Param('id') id: string) {
    return this.inventoryService.getHost(id);
  }

  @Put('hosts/:id/metadata')
  updateHostMetadata(
    @CurrentUser() user: { sub: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(hostMetadataUpdateSchema)) body: HostMetadataUpdate,
  ) {
    return this.inventoryService.updateHostMetadata(user.sub, id, body);
  }

  @Get('services')
  /**
   * Handles list services.
   */
  listServices() {
    return this.inventoryService.listServices();
  }

  @Get('services/:id')
  /**
   * Gets service.
   */
  getService(@Param('id') id: string) {
    return this.inventoryService.getService(id);
  }
}
