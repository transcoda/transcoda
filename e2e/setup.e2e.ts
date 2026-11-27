import { expect, test } from '@playwright/test';
import { STORAGE_STATE } from '../playwright.config.ts';
import { ADMIN } from './helpers.ts';

// The first flow, and the session every other spec starts from: create the admin on the first-run
// page, sign out, then sign in again with the same credentials.
test('first run creates the admin, and the admin can sign out and back in', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Create the admin account' })).toBeVisible();

  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Create account and sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});
