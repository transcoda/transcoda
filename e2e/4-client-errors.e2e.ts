import { expect, type Page, test } from '@playwright/test';

// The web UI's error reports, through a real browser: sendBeacon on pagehide, the CSRF token in
// the body, the server's checks, the metric (docs/dev/web-ui.md, "Error reports").

async function reported(page: Page): Promise<number> {
  const res = await page.request.get('/metrics');
  expect(res.status()).toBe(200);
  const m = /^transcoda_client_errors_total\{kind="error"\} (\d+)$/m.exec(await res.text());
  return Number(m?.[1] ?? Number.NaN);
}

test('an uncaught error in the page reaches the server when the page goes away', async ({
  page,
}) => {
  await page.goto('/jobs');
  await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
  const before = await reported(page);
  expect(before).toBeGreaterThanOrEqual(0);

  const thrown = page.waitForEvent('pageerror');
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('e2e probe');
    });
  });
  await thrown;
  // Leaving the page sends the queue at once (pagehide), well before the 5 s timer.
  await page.goto('/libraries');

  // The metrics snapshot is cached for 5 s.
  await expect.poll(() => reported(page), { timeout: 15_000 }).toBe(before + 1);
});
