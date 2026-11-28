import { expect, type Page, test } from '@playwright/test';
import { MOVIES_PATH } from './helpers.ts';

/** A node on the editor canvas by its title. */
const canvasNode = (page: Page, title: string) =>
  page
    .locator('[aria-roledescription="node"]')
    .filter({ has: page.getByText(title, { exact: true }) });

// Builds the workflow the other specs use: a library, the Save space example rewired to take its
// files from that library, saved and activated.
test('a library and a workflow built from an example, then activated', async ({ page }) => {
  await page.goto('/libraries');
  await page.getByRole('button', { name: 'New library' }).click();
  const dialog = page.getByRole('dialog', { name: 'New library' });
  await dialog.getByLabel('Name').fill('Movies');
  await dialog.getByLabel('Path').fill(MOVIES_PATH);
  await dialog.getByRole('button', { name: 'Create library' }).click();
  await expect(page.getByRole('link', { name: 'Movies' })).toBeVisible();

  await page.getByRole('link', { name: 'Workflows' }).click();
  // New workflow, then Cancel: back on the list, not on "Page not found" (#241).
  await page.getByRole('link', { name: 'New workflow' }).click();
  await expect(page.getByRole('heading', { name: 'New workflow', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Workflows', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: /^Save space/ }).click();
  await expect(page.getByRole('heading', { name: 'Save space', level: 1 })).toBeVisible();

  // Swap the example's Manual input for a Library input on Movies.
  await canvasNode(page, 'Manual input').click();
  await page.keyboard.press('Delete');
  await expect(canvasNode(page, 'Manual input')).toHaveCount(0);
  await page
    .getByRole('complementary', { name: 'Node palette' })
    .getByRole('button', { name: 'Library input' })
    .click();
  await page
    .getByRole('complementary', { name: 'Inspector' })
    .getByRole('combobox', { name: 'Library' })
    .selectOption({ label: 'Movies' });

  await canvasNode(page, 'Library input')
    .locator('.react-flow__handle[title="file out"]')
    .dragTo(canvasNode(page, 'Already HEVC?').locator('.react-flow__handle[title="file in"]'));
  await expect(
    page.getByRole('group', { name: 'Edge from Library input to Already HEVC?' }),
  ).toBeVisible();

  const issues = page.getByRole('region', { name: 'Issues' });
  await expect(issues.getByText(/error/i)).toHaveCount(0);

  await page.getByRole('button', { name: 'Save v2' }).click();
  await expect(page.getByRole('button', { name: /^v2 · Not active · saved/ })).toBeVisible();

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /^Activate v2/ }).click();
  const confirm = page.getByRole('dialog');
  await confirm.getByRole('button', { name: /^Activate/ }).click();
  await expect(page.getByRole('button', { name: /^Active v2/ })).toBeVisible();

  await page.getByRole('link', { name: 'Libraries' }).click();
  const row = page.getByRole('row', { name: /Movies/ });
  await expect(row.getByRole('link', { name: 'Save space' })).toBeVisible();
  await expect(row.getByText('Active')).toBeVisible();
});
