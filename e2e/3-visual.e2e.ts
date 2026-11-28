import { expect, type Page, test } from '@playwright/test';

// Screenshots of the main pages, after the flows have filled the server. Runs once per visual
// project (light, dark, phone; see playwright.config.ts). Baselines live in e2e/__screenshots__ and
// are made in the Playwright container: `pnpm e2e:update`.

/**
 * Text that changes from run to run, rewritten to fixed words on every render (a mask would keep the
 * text's own width, which changes with it): dates, relative times, durations, the weekday labels
 * under the charts, the build's version, the clock in dialogs, and sizes, bitrates and percentages. Runs in the page.
 */
function steadyText() {
  const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
  const rules: [RegExp, string][] = [
    [new RegExp(`\\b${MONTH} \\d{1,2}(?:, \\d{4})?(?:, \\d{1,2}:\\d{2})?`, 'g'), 'Jan 1'],
    [
      /\b(?:just now|\d+ (?:s|sec|min|h|hr|hours?|days?|d) ago|in \d+ (?:min|h|hours?|days?))\b/g,
      'just now',
    ],
    [/\btook \d+(?:\.\d+)? (?:ms|s|min|h)\b/g, 'took 1 s'],
    [/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/, 'Day'],
    [/v\d+\.\d+\.\d+-dev(?:\+\w+)?/g, 'v0.0.0-dev'],
    [/\bNow \d{1,2}:\d{2}\b/g, 'Now 00:00'],
    // Sizes, bitrates and savings: x265's output differs by a few bytes between CPUs (its SIMD
    // paths), and free disk space between machines.
    [/\b\d+(?:\.\d+)? (?:B|kB|MB|GB|TB)\b/g, '1 MB'],
    [/\b\d+(?:\.\d+)? (?:kb|Mb|Gb)\/s\b/g, '1 Mb/s'],
    [/\d+(?:\.\d+)? ?%/g, '50%'],
    // ffmpeg's log length depends on the machine (CPU notes, NUMA).
    [/^\d+ lines?$/, '10 lines'],
  ];
  const fix = (node: Node) => {
    const text = node.textContent ?? '';
    let next = text;
    for (const [re, to] of rules) next = next.replace(re, to);
    if (next !== text) node.textContent = next;
  };
  const walk = (root: Node) => {
    if (root.nodeType === Node.TEXT_NODE) return fix(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) fix(n);
  };
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') fix(r.target);
      for (const n of r.addedNodes) walk(n);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(steadyText);
});

async function shot(page: Page, name: string) {
  // Not 'networkidle': the live event stream stays open. Posters and fonts have to be in.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
}

test('main pages', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Save space' })).toBeVisible();
  await shot(page, 'workflows');

  await page.getByRole('link', { name: 'Save space' }).click();
  await expect(page.locator('[aria-roledescription="node"]').first()).toBeVisible();
  await shot(page, 'workflow-editor');

  await page.goto('/jobs');
  // A table on a desktop, a list of links on a phone.
  const harbor = page.getByRole('link', { name: /Harbor Lights/ }).first();
  await expect(harbor).toBeVisible();
  // The three "Nothing to do" jobs finish within the same instant, so their order is not fixed:
  // the shot shows the one replaced job.
  await page.getByRole('button', { name: /^Replaced/ }).click();
  await expect(page.getByRole('link', { name: /Quiet Meadow/ })).toHaveCount(0);
  await shot(page, 'jobs');

  await harbor.click();
  await expect(page.getByRole('heading', { name: /Harbor Lights/, level: 1 })).toBeVisible();
  await shot(page, 'job');

  await page.goto('/libraries');
  await expect(page.getByRole('link', { name: 'Movies' })).toBeVisible();
  await shot(page, 'libraries');

  await page.getByRole('link', { name: 'Movies' }).click();
  await expect(page.getByRole('link', { name: /Harbor Lights/ })).toBeVisible();
  await shot(page, 'library');
  const library = page.url();

  await page.getByRole('link', { name: /Harbor Lights/ }).click();
  await expect(page.getByRole('heading', { name: /Harbor Lights/, level: 1 })).toBeVisible();
  await shot(page, 'file');

  // The fixtures are all sound, so the damaged files page shows its empty state.
  await page.goto(library);
  await page.getByRole('link', { name: 'No damaged files' }).click();
  await expect(page.getByRole('heading', { name: 'Damaged files', level: 1 })).toBeVisible();
  await expect(page.getByText(/No damaged files in Movies/)).toBeVisible();
  await shot(page, 'damaged-files');

  for (const path of ['recycle', 'plugins', 'settings']) {
    await page.goto(`/${path}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await shot(page, path);
  }
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sign-in page', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await shot(page, 'sign-in');
  });
});
