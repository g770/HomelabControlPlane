/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the jwt strategy logic for the repository.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
/**
 * Implements the jwt strategy class.
 */
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@Inject(ConfigService) configService: ConfigService) {
    /**
     * Implements sse query token extractor.
     */
    const sseQueryTokenExtractor = (request: {
      path?: string;
      query?: Record<string, unknown>;
    }) => {
      if (!request?.path?.endsWith('/events/stream')) {
        return null;
      }
      const token = request.query?.token;
      return typeof token === 'string' ? token : null;
    };

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        sseQueryTokenExtractor,
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /**
   * Validates the requested value before the workflow continues.
   */
  validate(payload: { sub: string; email: string; displayName: string }) {
    return {
      sub: payload.sub,
      email: payload.email,
      displayName: payload.displayName,
    };
  }
}
