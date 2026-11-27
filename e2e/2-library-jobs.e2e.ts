import { expect, test } from '@playwright/test';

// Runs after 1-workflow.e2e.ts: the Movies library is fed by the active Save space workflow.
test.describe.configure({ mode: 'serial' });

test('scanning the library runs its files, and the library shows each one', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/libraries');
  await page.getByRole('button', { name: 'Scan Movies now' }).click();

  // Real ffmpeg runs on the four fixtures; each finishes as replaced, kept original or nothing to do.
  await page.goto('/jobs');
  const table = page.getByRole('table');
  for (const title of ['Otter and Finch', 'Harbor Lights', 'The Paper Lantern', 'Quiet Meadow']) {
    await expect(table.getByRole('row', { name: new RegExp(title) })).toContainText(
      /Replaced|Kept original|Nothing to do/,
      { timeout: 90_000 },
    );
  }

  await page.getByRole('link', { name: 'Libraries' }).click();
  await page.getByRole('link', { name: 'Movies' }).click();
  await expect(page.getByRole('heading', { name: 'Movies', level: 1 })).toBeVisible();
  for (const title of ['Otter and Finch', 'Harbor Lights', 'The Paper Lantern', 'Quiet Meadow']) {
    await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  }

  await page.getByRole('radio', { name: 'Table' }).check();
  await expect(page.getByRole('row', { name: /Harbor Lights/ })).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search this library' }).fill('lantern');
  await expect(page.getByRole('row', { name: /The Paper Lantern/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Harbor Lights/ })).toHaveCount(0);
});

test("a file's page shows its tracks and its jobs", async ({ page }) => {
  await page.goto('/libraries');
  await page.getByRole('link', { name: 'Movies' }).click();
  await page.getByRole('link', { name: /Harbor Lights/ }).click();
  await expect(page.getByRole('heading', { name: /Harbor Lights/, level: 1 })).toBeVisible();
  // The encode left HEVC video and both audio tracks.
  await expect(page.getByRole('definition').filter({ hasText: /^HEVC/ })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'English · AAC' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'German · AAC' })).toBeVisible();
  const jobs = page.getByRole('table', { name: 'Jobs on this file' });
  await expect(jobs.getByRole('row', { name: /Harbor Lights/ })).toContainText('Replaced');
});

test("a job's page shows its result and the steps it took", async ({ page }) => {
  await page.goto('/jobs');
  await page
    .getByRole('table')
    .getByRole('link', { name: /Harbor Lights/ })
    .click();
  await expect(page.getByRole('heading', { name: /Harbor Lights/, level: 1 })).toBeVisible();
  for (const step of ['Library input', 'Encode video', 'Render', 'Size gate']) {
    await expect(page.getByText(step, { exact: true }).first()).toBeVisible();
  }
});
