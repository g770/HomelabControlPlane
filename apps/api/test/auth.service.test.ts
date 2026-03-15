/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the auth service test behavior.
 */
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/modules/auth/auth.service';
import { LOCAL_ADMIN_EMAIL } from '../src/modules/auth/admin-account';

/**
 * Builds user.
 */
function buildUser(passwordHash: string | null) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: LOCAL_ADMIN_EMAIL,
    displayName: 'Admin',
    passwordHash,
    active: true,
  };
}

describe('AuthService', () => {
  const prisma = {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  };
  const jwtService = {
    signAsync: vi.fn(),
  };
  const auditService = {
    write: vi.fn(),
  };

  let service: AuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    jwtService.signAsync.mockResolvedValue('jwt-token');
    auditService.write.mockResolvedValue(undefined);
    service = new AuthService(prisma as never, jwtService as never, auditService as never);
  });

  it('reports setup required until the admin password exists', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(buildUser(null));

    await expect(service.getSetupStatus()).resolves.toEqual({ setupRequired: true });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: LOCAL_ADMIN_EMAIL },
    });
  });

  it('configures the first-run admin password once and writes an audit event', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(buildUser(null));
    prisma.user.update.mockImplementationOnce(
      async ({ data }: { data: { passwordHash: string } }) => buildUser(data.passwordHash),
    );

    const result = await service.setup('VerySecret123');

    expect(result).toEqual({ accessToken: 'jwt-token' });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: '11111111-1111-4111-8111-111111111111' },
      data: {
        passwordHash: expect.any(String),
        displayName: 'Admin',
        active: true,
      },
    });
    const updateInput = prisma.user.update.mock.calls[0]?.[0] as {
      data: { passwordHash: string };
    };
    await expect(compare('VerySecret123', updateInput.data.passwordHash)).resolves.toBe(true);
    expect(jwtService.signAsync).toHaveBeenCalledWith({
      sub: '11111111-1111-4111-8111-111111111111',
      email: LOCAL_ADMIN_EMAIL,
      displayName: 'Admin',
    });
    expect(auditService.write).toHaveBeenCalledWith({
      actorUserId: '11111111-1111-4111-8111-111111111111',
      action: 'auth.password.setup',
      targetType: 'user',
      targetId: '11111111-1111-4111-8111-111111111111',
      paramsJson: {
        source: 'first_run',
      },
      success: true,
    });
    expect(JSON.stringify(auditService.write.mock.calls[0]?.[0])).not.toContain('VerySecret123');
  });

  it('rejects setup after the admin password has already been configured', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(buildUser(await hash('ExistingSecret123', 12)));

    await expect(service.setup('VerySecret123')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(auditService.write).not.toHaveBeenCalled();
  });

  it('blocks login before first-run setup completes', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(buildUser(null));

    await expect(service.login('VerySecret123')).rejects.toBeInstanceOf(ConflictException);
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it('rejects invalid admin passwords during login', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(buildUser(await hash('VerySecret123', 12)));

    await expect(service.login('WrongSecret123')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it('signs in with the configured admin password', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(buildUser(await hash('VerySecret123', 12)));

    await expect(service.login('VerySecret123')).resolves.toEqual({ accessToken: 'jwt-token' });
    expect(jwtService.signAsync).toHaveBeenCalledOnce();
  });

  it('changes the admin password and writes an audit event without leaking secrets', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(buildUser(await hash('CurrentSecret123', 12)));
    prisma.user.update.mockResolvedValueOnce(buildUser(await hash('NewSecret123', 12)));

    await expect(
      service.changePassword(
        '11111111-1111-4111-8111-111111111111',
        'CurrentSecret123',
        'NewSecret123',
      ),
    ).resolves.toEqual({ ok: true });

    const updateInput = prisma.user.update.mock.calls[0]?.[0] as {
      data: { passwordHash: string };
    };
    await expect(compare('NewSecret123', updateInput.data.passwordHash)).resolves.toBe(true);
    expect(auditService.write).toHaveBeenCalledWith({
      actorUserId: '11111111-1111-4111-8111-111111111111',
      action: 'auth.password.change',
      targetType: 'user',
      targetId: '11111111-1111-4111-8111-111111111111',
      paramsJson: {
        source: 'settings',
      },
      success: true,
    });
    expect(JSON.stringify(auditService.write.mock.calls[0]?.[0])).not.toContain('CurrentSecret123');
    expect(JSON.stringify(auditService.write.mock.calls[0]?.[0])).not.toContain('NewSecret123');
  });

  it('returns the admin profile without role metadata', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(buildUser(await hash('VerySecret123', 12)));

    await expect(service.getMe('11111111-1111-4111-8111-111111111111')).resolves.toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Admin',
    });
  });
});
