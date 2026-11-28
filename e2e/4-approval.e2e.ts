import { expect, type Page, test } from '@playwright/test';
import { MOVIES_PATH } from './helpers.ts';

// Runs after 2-library-jobs.e2e.ts. A second workflow holds its result for a person: one file is
// rejected here, the other is left waiting, so 3-visual.e2e.ts can take the waiting job's page.
test.describe.configure({ mode: 'serial' });

const node = (id: string, type: string, x: number, settings: Record<string, unknown> = {}) => ({
  id,
  type,
  typeVersion: 1,
  settings,
  position: { x, y: 0 },
});
const edge = (from: string, fromPort: string, to: string) => ({
  id: `${from}-${to}`,
  from: { node: from, port: fromPort },
  to: { node: to, port: 'file' },
});

/** Keep English only (both fixtures also carry German), then wait for approval before replacing. */
const GRAPH = {
  formatVersion: 2,
  kind: 'workflow',
  nodes: [
    node('input', 'core:input-manual', 0),
    node('languages', 'core:keep-languages', 240, {
      languages: ['en'],
      keepOriginal: false,
      keepUntagged: true,
    }),
    node('render', 'core:render', 480),
    node('approval', 'core:approval', 720),
    node('replace', 'core:replace-original', 960),
  ],
  edges: [
    edge('input', 'file', 'languages'),
    edge('languages', 'file', 'render'),
    edge('render', 'done', 'approval'),
    edge('approval', 'pass', 'replace'),
  ],
  groups: [],
};

/** A JSON call as the signed-in admin (the session cookie, plus the CSRF token for a change). */
async function call(page: Page, method: 'GET' | 'POST', path: string, data?: unknown) {
  const me = await page.request.get('/api/v1/auth/me');
  const { csrfToken } = (await me.json()) as { csrfToken: string };
  const res = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers: { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

const movie = (title: string) => `${MOVIES_PATH}/${title}/${title}.mkv`;

test('a result waits for approval, shows on the Jobs page and its job page, and Reject keeps the original', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/jobs');
  const created = await call(page, 'POST', '/workflows', {
    name: 'Hold for approval',
    kind: 'workflow',
    graph: GRAPH,
  });
  const id = String(created.id);
  await call(page, 'POST', `/workflows/${id}/activate`, { version: 1, confirm: true });
  for (const title of ['Quiet Meadow (1934)', 'The Paper Lantern (1928)']) {
    await call(page, 'POST', '/jobs', { path: movie(title), workflowId: id, fileOnly: true });
  }

  // Both wait: the filter of its own lists them.
  await page.goto('/jobs');
  await page.getByRole('button', { name: /^Waiting for approval 2/ }).click({ timeout: 90_000 });
  const table = page.getByRole('table');
  for (const title of ['Quiet Meadow', 'The Paper Lantern']) {
    // Right after the click the old, unfiltered list (with each title's earlier jobs) can still be
    // on screen; wait for the filtered one, where each title has a single row.
    const row = table.getByRole('row', { name: new RegExp(title) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Waiting for approval');
  }

  await table.getByRole('link', { name: /Quiet Meadow/ }).click();
  const panel = page.getByRole('region', { name: 'Waiting for your approval' });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('region', { name: 'Before and after' })).toContainText(
    'After (waiting for approval)',
  );
  await panel.getByRole('button', { name: 'Reject' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reject this result?' });
  await dialog.getByRole('button', { name: 'Reject result' }).click();
  await expect(page.locator('.job-head-chips .job-chip')).toHaveText('Kept original');
  await expect(panel).toHaveCount(0);

  // The other one still waits.
  await page.goto('/jobs');
  await expect(page.getByRole('button', { name: /^Waiting for approval 1/ })).toBeVisible();
});
