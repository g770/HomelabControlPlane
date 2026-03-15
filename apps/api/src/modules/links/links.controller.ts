/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes links controller request handling for the API service.
 */
import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import { LinksService } from './links.service';

// Dashboard endpoints for link/widget layout reads, writes, and suggestions.
@Controller('links')
/**
 * Implements the links controller class.
 */
export class LinksController {
  constructor(private readonly linksService: LinksService) {}

  @Get('dashboard')
  /**
   * Gets dashboard.
   */
  getDashboard(@CurrentUser() user: { sub: string }) {
    return this.linksService.getDashboard(user.sub);
  }

  @Put('dashboard')
  /**
   * Handles update dashboard.
   */
  updateDashboard(@CurrentUser() user: { sub: string }, @Body() body: unknown) {
    return this.linksService.updateDashboard(user.sub, body);
  }

  @Get('suggestions')
  /**
   * Handles list suggestions.
   */
  listSuggestions() {
    return this.linksService.listSuggestions();
  }
}
