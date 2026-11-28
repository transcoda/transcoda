import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_ERRORS_PATH } from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../../app/testing/app.ts';
import {
  asSession,
  bearer,
  createToken,
  HOST,
  login,
  ORIGIN,
  type Session,
} from '../../app/testing/http.ts';
import type { Logger } from '../../platform/logger.ts';
import { CLIENT_ERROR_LOG_LIMIT, CLIENT_ERRORS_MAX_BYTES } from './client-errors.ts';

let t: TestApp;
let s: Session;

afterEach(async () => {
  await t.close();
});

function capture() {
  const warn = vi.fn<Logger['warn']>();
  const log: Logger = { info: vi.fn(), warn, error: vi.fn() };
  const lines = () =>
    warn.mock.calls
      .map(([e]) => e)
      .filter((e): e is { msg: string } & Record<string, unknown> => typeof e === 'object');
  return { log, lines, reports: () => lines().filter((e) => e.msg === 'client_error') };
}

async function setup(config: { webDistDir?: string } = {}) {
  const c = capture();
  t = createTestApp({ log: c.log, config });
  s = await login(t);
  return c;
}

const event = (over: Record<string, unknown> = {}) => ({
  kind: 'error',
  route: '/jobs/:id',
  version: '0.9.0',
  name: 'TypeError',
  message: 'x is not a function',
  stack: ['at f (/assets/index-abc123.js:1:5)'],
  count: 1,
  ...over,
});

function post(body: unknown, headers: Record<string, string> = asSession(s, false)) {
  return Promise.resolve(
    t.app.request(CLIENT_ERRORS_PATH, {
      method: 'POST',
      // sendBeacon's type for a string body; the server reads JSON whatever the type says.
      headers: {
        host: HOST,
        origin: ORIGIN,
        'content-type': 'text/plain;charset=UTF-8',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

const batch = (events: unknown[] = [event()]) => ({ csrf: s.csrf, events });

async function counted(kind: string): Promise<number> {
  const text = await t.deps.metrics.exposition();
  const m = new RegExp(`^transcoda_client_errors_total\\{kind="${kind}"\\} (\\d+)$`, 'm').exec(
    text,
  );
  return Number(m?.[1]);
}

describe(`POST ${CLIENT_ERRORS_PATH}`, () => {
  it('logs each event as client_error and counts it by kind', async () => {
    const c = await setup();
    const res = await post(batch([event(), event({ kind: 'api', count: 4, stack: [] })]));
    expect(res.status).toBe(204);
    expect(c.reports()).toEqual([
      {
        msg: 'client_error',
        kind: 'error',
        route: '/jobs/:id',
        version: '0.9.0',
        name: 'TypeError',
        message: 'x is not a function',
        count: 1,
        stack: ['at f (/assets/index-abc123.js:1:5)'],
      },
      expect.objectContaining({ kind: 'api', count: 4 }),
    ]);
    t.clock.advance(10_000);
    expect(await counted('api')).toBe(4);
    expect(await counted('error')).toBe(1);
    expect(await counted('csp')).toBe(0);
  });

  it('scrubs a hand-made request again: no path, title, URL or host reaches the log', async () => {
    const c = await setup();
    const res = await post(
      batch([
        event({
          route: '/libraries/Movies/files/Harbor Lights',
          message: 'open "Harbor Lights" at /media/Movies/Harbor Lights.mkv',
          stack: ['at f (http://nas.example:8080/assets/index-abc123.js?x=1:1:5)'],
        }),
      ]),
    );
    expect(res.status).toBe(204);
    const [line] = c.reports();
    expect(line).toMatchObject({
      route: '<unknown>',
      message: 'open "…" at <path>',
      stack: ['at f (/assets/index-abc123.js:1:5)'],
    });
    expect(JSON.stringify(line)).not.toMatch(/Harbor|Movies|nas\.example|media/);
  });

  it('resolves frames with the source maps next to the bundles', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'tcd-web-'));
    mkdirSync(join(dist, 'assets'));
    // Generated line 1 maps to src/jobs/JobPage.tsx line 1, generated line 2 to its line 3.
    writeFileSync(
      join(dist, 'assets', 'index-abc123.js.map'),
      JSON.stringify({
        version: 3,
        sources: ['../../src/jobs/JobPage.tsx'],
        names: [],
        mappings: 'AAAA;AAEA',
      }),
    );
    const c = await setup({ webDistDir: dist });
    await post(
      batch([
        event({
          stack: [
            'at f (/assets/index-abc123.js:2:1)',
            'at g (/assets/missing-0.js:1:1)',
            'at <anonymous>:1:1',
          ],
        }),
      ]),
    );
    expect(c.reports()[0]?.stack).toEqual([
      'at f (src/jobs/JobPage.tsx:3:1)',
      'at g (/assets/missing-0.js:1:1)',
      'at <anonymous>:1:1',
    ]);
  });

  it('writes at most a set number of lines a minute, says so once, and counts every event', async () => {
    const c = await setup();
    const many = Array.from({ length: 20 }, () => event());
    for (let i = 0; i < 4; i += 1) expect((await post(batch(many))).status).toBe(204);
    expect(c.reports()).toHaveLength(CLIENT_ERROR_LOG_LIMIT);
    expect(c.lines().filter((e) => e.msg === 'client_error throttled')).toHaveLength(1);
    t.clock.advance(60_000);
    await post(batch());
    expect(c.reports()).toHaveLength(CLIENT_ERROR_LOG_LIMIT + 1);
    expect(await counted('error')).toBe(81);
  });

  describe('refuses', () => {
    it('a caller without a session', async () => {
      const c = await setup();
      const res = await post(batch(), {});
      expect(res.status).toBe(401);
      expect(c.reports()).toEqual([]);
    });

    it('an API token, whatever its scopes', async () => {
      await setup();
      const { token } = await createToken(t, s, { name: 'x', scopes: ['read', 'jobs:create'] });
      expect((await post(batch(), bearer(token))).status).toBe(403);
    });

    it('a wrong or missing CSRF token', async () => {
      const c = await setup();
      expect((await post({ ...batch(), csrf: 'forged' })).status).toBe(403);
      expect((await post({ events: [event()] })).status).toBe(400);
      expect(c.reports()).toEqual([]);
    });

    it('another site', async () => {
      await setup();
      const res = await post(batch(), { ...asSession(s, false), origin: 'https://evil.example' });
      expect(res.status).toBe(403);
      const noOrigin = await t.app.request(CLIENT_ERRORS_PATH, {
        method: 'POST',
        headers: { host: HOST, ...asSession(s, false), 'sec-fetch-site': 'cross-site' },
        body: JSON.stringify(batch()),
      });
      expect(noOrigin.status).toBe(403);
    });

    it('a body that is not JSON or not a report', async () => {
      const c = await setup();
      expect((await post('not json')).status).toBe(400);
      expect((await post({ ...batch(), extra: 1 })).status).toBe(400);
      expect((await post(batch([event({ kind: 'pageview' })]))).status).toBe(400);
      expect((await post(batch([]))).status).toBe(400);
      expect((await post(batch(Array.from({ length: 21 }, () => event())))).status).toBe(400);
      expect(c.reports()).toEqual([]);
      t.clock.advance(10_000);
      expect(await counted('error')).toBe(0);
    });

    it(`a body over ${CLIENT_ERRORS_MAX_BYTES} bytes`, async () => {
      await setup();
      const res = await post({ ...batch(), pad: 'x'.repeat(CLIENT_ERRORS_MAX_BYTES) });
      expect(res.status).toBe(413);
    });

    it('a host that is not allowed', async () => {
      await setup();
      const res = await post(batch(), { ...asSession(s, false), host: 'evil.example' });
      expect(res.status).toBe(403);
    });
  });
});
