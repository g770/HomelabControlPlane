/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements auth service business logic for the service layer.
 */
import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LOCAL_ADMIN_DISPLAY_NAME, LOCAL_ADMIN_EMAIL } from './admin-account';

@Injectable()
/**
 * Implements the auth service class.
 */
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Gets setup status.
   */
  async getSetupStatus() {
    const user = await this.findAdminAccount();
    return {
      setupRequired: !user?.passwordHash,
    };
  }

  /**
   * Sets setup.
   */
  async setup(password: string) {
    const existing = await this.findAdminAccount();
    if (existing?.passwordHash) {
      throw new ConflictException('Admin password has already been configured');
    }

    const passwordHash = await hash(password, 12);
    const user = existing
      ? await this.prisma.user.update({
          where: { id: existing.id },
          data: {
            passwordHash,
            displayName: LOCAL_ADMIN_DISPLAY_NAME,
            active: true,
          },
        })
      : await this.prisma.user.create({
          data: {
            email: LOCAL_ADMIN_EMAIL,
            displayName: LOCAL_ADMIN_DISPLAY_NAME,
            passwordHash,
            active: true,
          },
        });

    await this.auditService.write({
      actorUserId: user.id,
      action: 'auth.password.setup',
      targetType: 'user',
      targetId: user.id,
      paramsJson: {
        source: 'first_run',
      },
      success: true,
    });

    return this.buildLoginResponse(user);
  }

  /**
   * Handles login.
   */
  async login(password: string) {
    const user = await this.findAdminAccount();

    if (!user || !user.active || !user.passwordHash) {
      throw new ConflictException('Admin password has not been configured');
    }

    const isValid = await compare(password, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.buildLoginResponse(user);
  }

  /**
   * Handles change password.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.active || !user.passwordHash) {
      throw new UnauthorizedException('User not found');
    }

    const isValid = await compare(currentPassword, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const passwordHash = await hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
      },
    });

    await this.auditService.write({
      actorUserId: user.id,
      action: 'auth.password.change',
      targetType: 'user',
      targetId: user.id,
      paramsJson: {
        source: 'settings',
      },
      success: true,
    });

    return { ok: true };
  }

  /**
   * Gets me.
   */
  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.active) {
      throw new UnauthorizedException('User not found');
    }

    return {
      id: user.id,
      displayName: user.displayName,
    };
  }

  /**
   * Handles find admin account.
   */
  private async findAdminAccount() {
    return this.prisma.user.findUnique({
      where: { email: LOCAL_ADMIN_EMAIL },
    });
  }

  /**
   * Builds login response for the surrounding workflow.
   */
  private async buildLoginResponse(user: { id: string; email: string; displayName: string }) {
    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      email: user.email,
      displayName: user.displayName,
    });

    return { accessToken };
  }
}
