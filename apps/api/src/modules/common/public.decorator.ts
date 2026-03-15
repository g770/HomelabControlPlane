/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the public decorator logic for the repository.
 */
import { SetMetadata } from '@nestjs/common';

/**
 * Defines the is_public_key constant.
 */
export const IS_PUBLIC_KEY = 'isPublic';
/**
 * Renders the public view.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
