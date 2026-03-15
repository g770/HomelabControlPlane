/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the auth spec behavior.
 */
import { expect, test } from '@playwright/test';

test('redirects protected dashboard route to login when unauthenticated', async ({ page }) => {
  await page.route('**/api/auth/setup-status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setupRequired: false }),
    });
  });

  await page.goto('/dashboard');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('renders first-run admin password setup when setup is required', async ({ page }) => {
  await page.route('**/api/auth/setup-status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setupRequired: true }),
    });
  });

  await page.goto('/login');

  await expect(page.getByRole('heading', { name: 'Set Admin Password' })).toBeVisible();
  await expect(
    page.getByText('Finish first-run setup by creating the local admin password.'),
  ).toBeVisible();
});

test('renders login failures from mocked API responses', async ({ page }) => {
  await page.route('**/api/auth/setup-status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setupRequired: false }),
    });
  });
  await page.route('**/api/auth/login', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'text/plain',
      body: 'Invalid credentials',
    });
  });

  await page.goto('/login');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText('API 401: Invalid credentials')).toBeVisible();
});

test('@smoke login page renders', async ({ page }) => {
  await page.route('**/api/auth/setup-status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ setupRequired: false }),
    });
  });

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
