/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the common guards test behavior.
 */
import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '../src/modules/common/jwt-auth.guard';

/**
 * Creates execution context.
 */
function createExecutionContext(): ExecutionContext {
  return {
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({
      getRequest: () => ({
        user: undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  it('allows requests to public handlers without invoking passport auth', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(true),
    } as unknown as Reflector;
    const passportCanActivateSpy = vi
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockReturnValue(true as never);

    const guard = new JwtAuthGuard(reflector);
    const result = guard.canActivate(createExecutionContext());

    expect(result).toBe(true);
    expect(passportCanActivateSpy).not.toHaveBeenCalled();
  });

  it('delegates non-public requests to passport auth', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const passportCanActivateSpy = vi
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockReturnValue(true as never);

    const guard = new JwtAuthGuard(reflector);
    const result = guard.canActivate(createExecutionContext());

    expect(result).toBe(true);
    expect(passportCanActivateSpy).toHaveBeenCalledOnce();
  });
});
