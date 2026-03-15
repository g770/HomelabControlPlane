/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes auth controller request handling for the API service.
 */
import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  authChangePasswordSchema,
  authSetupRequestSchema,
  loginRequestSchema,
} from '@homelab/shared';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';

@Controller()
/**
 * Implements the auth controller class.
 */
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Get('auth/setup-status')
  /**
   * Gets setup status.
   */
  getSetupStatus() {
    return this.authService.getSetupStatus();
  }

  @Public()
  @Post('auth/setup')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  setup(
    @Body(new ZodValidationPipe(authSetupRequestSchema))
    body: {
      confirm: true;
      password: string;
    },
  ) {
    return this.authService.setup(body.password);
  }

  @Public()
  @Post('auth/login')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  /**
   * Handles login.
   */
  login(@Body(new ZodValidationPipe(loginRequestSchema)) body: { password: string }) {
    return this.authService.login(body.password);
  }

  @Post('auth/change-password')
  changePassword(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(authChangePasswordSchema))
    body: { confirm: true; currentPassword: string; newPassword: string },
  ) {
    return this.authService.changePassword(user.sub, body.currentPassword, body.newPassword);
  }

  @Post('auth/logout')
  /**
   * Handles logout.
   */
  logout() {
    return { ok: true };
  }

  @Get('me')
  /**
   * Handles me.
   */
  me(@CurrentUser() user: { sub: string }) {
    return this.authService.getMe(user.sub);
  }
}
