/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes users controller request handling for the API service.
 */
import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import {
  dashboardOrphanRecoveryNoticeUpdateSchema,
  dashboardSuggestionsNoticeUpdateSchema,
  discoverySubnetsUpdateSchema,
  hiddenHostsUpdateSchema,
  hostListColumnsUpdateSchema,
  sidebarNavigationUpdateSchema,
  uiThemeSettingsUpdateSchema,
  type DashboardOrphanRecoveryNoticeUpdate,
  type DashboardSuggestionsNoticeUpdate,
  type DiscoverySubnetsUpdate,
  type HiddenHostsUpdate,
  type HostListColumnsUpdate,
  type SidebarNavigationUpdate,
  type UiThemeSettingsUpdate,
} from '@homelab/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UsersService } from './users.service';

// Authenticated self-service endpoints for the built-in admin account.
@Controller()
/**
 * Implements the users controller class.
 */
export class UsersController {
  constructor(@Inject(UsersService) private readonly usersService: UsersService) {}

  @Get('account/theme')
  /**
   * Gets theme.
   */
  getTheme(@CurrentUser() user: { sub: string }) {
    return this.usersService.getTheme(user.sub);
  }

  @Put('account/theme')
  updateTheme(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(uiThemeSettingsUpdateSchema)) body: UiThemeSettingsUpdate,
  ) {
    return this.usersService.updateTheme(user.sub, body.theme);
  }

  @Get('account/preferences')
  /**
   * Gets preferences.
   */
  getPreferences(@CurrentUser() user: { sub: string }) {
    return this.usersService.getPreferences(user.sub);
  }

  @Put('account/preferences/hidden-hosts')
  updateHiddenHosts(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(hiddenHostsUpdateSchema)) body: HiddenHostsUpdate,
  ) {
    return this.usersService.updateHiddenHosts(user.sub, body.hiddenHostIds);
  }

  @Put('account/preferences/discovery-subnets')
  updateDiscoverySubnets(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(discoverySubnetsUpdateSchema)) body: DiscoverySubnetsUpdate,
  ) {
    return this.usersService.updateDiscoverySubnets(user.sub, body.discoverySubnets);
  }

  @Put('account/preferences/host-list-columns')
  updateHostListColumns(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(hostListColumnsUpdateSchema)) body: HostListColumnsUpdate,
  ) {
    return this.usersService.updateHostListColumns(user.sub, body.hostListColumns);
  }

  @Put('account/preferences/dashboard-suggestions-notice')
  updateDashboardSuggestionsNotice(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(dashboardSuggestionsNoticeUpdateSchema))
    body: DashboardSuggestionsNoticeUpdate,
  ) {
    return this.usersService.updateDashboardSuggestionsNotice(user.sub, body.dismissedFingerprint);
  }

  @Put('account/preferences/dashboard-orphan-recovery-notice')
  updateDashboardOrphanRecoveryNotice(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(dashboardOrphanRecoveryNoticeUpdateSchema))
    body: DashboardOrphanRecoveryNoticeUpdate,
  ) {
    return this.usersService.updateDashboardOrphanRecoveryNotice(
      user.sub,
      body.dismissedFingerprint,
    );
  }

  @Put('account/preferences/sidebar-navigation')
  updateSidebarNavigation(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(sidebarNavigationUpdateSchema)) body: SidebarNavigationUpdate,
  ) {
    return this.usersService.updateSidebarNavigation(user.sub, body.orderedItemIds);
  }
}
