import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BlocklistClient,
  type BlocklistClientDeps,
  BlocklistSchema,
  matchBlocklist,
} from './blocklist.ts';
import type { SigningKey } from './signature.ts';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const key: SigningKey = {
  id: 'k1',
  publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
};
const sigFor = (body: string) =>
  JSON.stringify({
    schema: 1,
    alg: 'ed25519',
    keyId: 'k1',
    signature: sign(null, Buffer.from(body), privateKey).toString('base64'),
  });

const GENERATED = '2026-10-17T00:00:00.000Z';
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'bl-1',
  name: 'demo',
  versions: '>=1.0.0 <2.0.0',
  reason: 'Exfiltrates tokens',
  url: 'https://example.com/advisory/1',
  added: GENERATED,
  ...over,
});
const doc = (entries: unknown[]) => ({ schema: 1, generated: GENERATED, entries });
const text = (entries: unknown[], generated = GENERATED) =>
  JSON.stringify({ ...doc(entries), generated });
const accepts = (entries: unknown[]) => BlocklistSchema.safeParse(doc(entries)).success;

// The same accept/reject examples as the plugins repo's scripts/check-blocklist.test.mjs: the two
// validators must agree.
describe('BlocklistSchema (mirrors check-blocklist.mjs)', () => {
  it('accepts sha-only and name+range entries', () => {
    expect(
      accepts([
        entry(),
        entry({ id: 'bl-2', name: undefined, versions: undefined, sha256: 'f'.repeat(64) }),
      ]),
    ).toBe(true);
    expect(accepts([])).toBe(true);
  });

  it('url defaults to null and may be null', () => {
    const r = BlocklistSchema.parse(
      doc([entry({ url: undefined }), entry({ id: 'b', url: null })]),
    );
    expect(r.entries.map((e) => e.url)).toEqual([null, null]);
  });

  it('refuses an entry with neither sha256 nor name', () => {
    expect(accepts([entry({ name: undefined, versions: undefined })])).toBe(false);
  });

  it('refuses versions without name', () => {
    expect(accepts([entry({ name: undefined, sha256: 'a'.repeat(64) })])).toBe(false);
  });

  it.each([
    ['a bad range', { versions: 'not a range' }],
    ['an empty range', { versions: '' }],
    ['a bad hash', { sha256: 'XYZ' }],
    ['a bad name', { name: 'Bad_Name' }],
    ['a long reason', { reason: 'x'.repeat(201) }],
    ['a blank reason', { reason: '   ' }],
    ['an unknown entry key', { extra: 1 }],
    ['a non-https url', { url: 'http://example.com/a' }],
    ['a bad added', { added: 'yesterday' }],
  ])('refuses %s', (_label, over) => {
    expect(accepts([entry(over)])).toBe(false);
  });

  it('refuses an unknown document key and a bad envelope', () => {
    expect(BlocklistSchema.safeParse({ ...doc([]), note: 'x' }).success).toBe(false);
    expect(
      BlocklistSchema.safeParse({ schema: 2, generated: 'yesterday', entries: 'no' }).success,
    ).toBe(false);
  });
});

describe('matchBlocklist', () => {
  const entries = BlocklistSchema.parse(
    doc([
      entry({ id: 'range' }),
      entry({ id: 'any', name: 'anyver', versions: undefined, reason: 'all versions' }),
      entry({ id: 'sha', name: undefined, versions: undefined, sha256: 'c'.repeat(64) }),
    ]),
  ).entries;
  const p = (over: Record<string, string> = {}) => ({
    name: 'other',
    version: '1.5.0',
    sha256: 'd'.repeat(64),
    ...over,
  });

  it('matches by sha256 whatever the name', () => {
    expect(matchBlocklist(entries, p({ sha256: 'c'.repeat(64) }))?.id).toBe('sha');
  });
  it('matches by name without a range: every version', () => {
    expect(matchBlocklist(entries, p({ name: 'anyver', version: '9.9.9' }))).toEqual({
      id: 'any',
      reason: 'all versions',
      url: 'https://example.com/advisory/1',
    });
  });
  it('matches by name with a range', () => {
    expect(matchBlocklist(entries, p({ name: 'demo', version: '1.5.0' }))?.id).toBe('range');
    expect(matchBlocklist(entries, p({ name: 'demo', version: '2.0.0' }))).toBeNull();
  });
  it('matches a prerelease against a caret range', () => {
    const caret = BlocklistSchema.parse(doc([entry({ versions: '^1' })])).entries;
    expect(matchBlocklist(caret, p({ name: 'demo', version: '1.1.0-beta.1' }))?.id).toBe('bl-1');
  });
  it('answers null for a build nothing names', () => {
    expect(matchBlocklist(entries, p())).toBeNull();
  });
});

describe('BlocklistClient', () => {
  const servers: Server[] = [];
  let dir: string;
  let files: Record<string, { status?: number; body: string }>;
  let base: string;
  const warn = vi.fn();
  const log = { info: vi.fn(), warn, error: vi.fn() };
  let nowMs = Date.parse('2026-10-17T12:00:00.000Z');

  function serverClose(s: Server, r: (v?: unknown) => void) {
    s.closeAllConnections();
    s.close(r);
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-blocklist-'));
    files = {};
    warn.mockClear();
    nowMs = Date.parse('2026-10-17T12:00:00.000Z');
    const server = createServer((req, res) => {
      const f = files[req.url ?? ''];
      res.statusCode = f?.status ?? (f ? 200 : 404);
      res.end(f?.body ?? 'nope');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => serverClose(s, r))));
  });

  const publish = (entries: unknown[], signed = true, generated = GENERATED) => {
    const body = text(entries, generated);
    files['/blocklist.json'] = { body };
    if (signed) files['/blocklist.json.sig'] = { body: sigFor(body) };
    else delete files['/blocklist.json.sig'];
  };
  const client = (over: Partial<BlocklistClientDeps> = {}) =>
    new BlocklistClient({
      url: `${base}/blocklist.json`,
      keys: [key],
      cacheDir: join(dir, 'cache'),
      token: null,
      now: () => new Date(nowMs),
      allowFileUrls: true,
      log,
      ...over,
    });
  const demo = { name: 'demo', version: '1.2.0', sha256: 'a'.repeat(64) };

  it('fetches, verifies and enforces a signed list', async () => {
    publish([entry(), entry({ id: 'bl-2', name: 'zed', versions: undefined })]);
    const c = client();
    const st = await c.refresh();
    expect(st).toEqual({ error: null, fetchedAt: '2026-10-17T12:00:00.000Z', entries: 2 });
    expect(c.match(demo)).toEqual({
      id: 'bl-1',
      reason: 'Exfiltrates tokens',
      url: 'https://example.com/advisory/1',
    });
    expect(c.match({ ...demo, name: 'fine' })).toBeNull();
  });

  it('Review Focus 2: a list with one malformed entry is invalid as a whole; the previous list stays in force', async () => {
    publish([entry()]);
    const c = client();
    await c.refresh();
    publish([entry({ id: 'good', name: 'zed' }), entry({ id: 'bad', versions: 'not a range' })]);
    const st = await c.refresh(true);
    expect(st.error).toMatch(/^invalid blocklist: /);
    expect(st.entries).toBe(1);
    expect(c.match(demo)?.id).toBe('bl-1');
    expect(c.match({ ...demo, name: 'zed' })).toBeNull();
  });

  it('a network error after a verified cache keeps the entries (a new client reads the cache)', async () => {
    publish([entry()]);
    await client().refresh();
    const later = client();
    expect(await later.loadCache()).toBe(1);
    files = {};
    servers[0]?.closeAllConnections();
    const down = client({ url: 'http://127.0.0.1:1/blocklist.json' });
    await down.loadCache();
    const st = await down.refresh(true);
    expect(st.error).toMatch(/^blocklist fetch failed: /);
    expect(down.match(demo)?.id).toBe('bl-1');
    expect(later.match(demo)?.id).toBe('bl-1');
  });

  it('a .sig that answers 404 is "blocklist signature missing"; entries are kept', async () => {
    publish([entry()]);
    const c = client();
    await c.refresh();
    publish([entry({ id: 'other', name: 'zed' })], false);
    const st = await c.refresh(true);
    expect(st.error).toBe('blocklist signature missing');
    expect(c.match(demo)?.id).toBe('bl-1');
  });

  it('a signature by an unknown key or over other bytes is refused; entries are kept', async () => {
    publish([entry()]);
    const c = client();
    await c.refresh();
    publish([entry({ id: 'other', name: 'zed' })]);
    files['/blocklist.json.sig'] = { body: sigFor('something else') };
    expect((await c.refresh(true)).error).toBe(
      'blocklist signature invalid: signature does not match',
    );
    const other = client({ keys: [{ ...key, id: 'k9' }] });
    publish([entry()]);
    expect((await other.refresh()).error).toBe(
      'blocklist signature invalid: signed with an unknown key k1',
    );
    expect(other.match(demo)).toBeNull();
    expect(c.match(demo)?.id).toBe('bl-1');
  });

  it('rollback protection: an older but validly signed list is refused, in memory and after a restart; equal or newer is accepted', async () => {
    const T1 = '2026-10-16T00:00:00.000Z';
    const T2 = '2026-10-17T00:00:00.000Z';
    const T3 = '2026-10-18T00:00:00.000Z';
    publish([entry(), entry({ id: 'bl-2', name: 'zed', versions: undefined })], true, T2);
    const c = client();
    await c.refresh();
    publish([], true, T1);
    const st = await c.refresh(true);
    expect(st.error).toBe('blocklist older than the list in force');
    expect(st.entries).toBe(2);
    expect(c.match(demo)?.id).toBe('bl-1');
    // The cache still holds A: a restarted client enforces it and refuses B too.
    const restarted = client();
    expect(await restarted.loadCache()).toBe(2);
    expect((await restarted.refresh(true)).error).toBe('blocklist older than the list in force');
    expect(restarted.match(demo)?.id).toBe('bl-1');
    publish([entry()], true, T2);
    expect((await c.refresh(true)).error).toBeNull();
    expect(c.status().entries).toBe(1);
    publish([], true, T3);
    expect((await c.refresh(true)).entries).toBe(0);
  });

  it('a cache written without `generated` counts as no cache', async () => {
    publish([entry()]);
    await client().refresh();
    const file = join(dir, 'cache', 'blocklist.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.generated).toBe(GENERATED);
    delete raw.generated;
    writeFileSync(file, JSON.stringify(raw));
    expect(await client().loadCache()).toBe(0);
  });

  it('keys null reads the list unsigned', async () => {
    publish([entry()], false);
    const c = client({ keys: null });
    expect((await c.refresh()).entries).toBe(1);
    expect(c.match(demo)?.id).toBe('bl-1');
  });

  it('an unsigned cache is not enforced once keys are required', async () => {
    publish([entry()], false);
    await client({ keys: null }).refresh();
    const strict = client();
    expect(await strict.loadCache()).toBe(0);
    expect(strict.match(demo)).toBeNull();
  });

  it('nothing loaded: match answers null and the error is reported', async () => {
    const c = client();
    const st = await c.refresh();
    expect(st).toMatchObject({ entries: 0, fetchedAt: null });
    expect(st.error).not.toBeNull();
    expect(c.match(demo)).toBeNull();
  });

  it('reads a file: url (one from disk, with and without a signature)', async () => {
    const file = join(dir, 'blocklist.json');
    writeFileSync(file, text([entry()]));
    const url = pathToFileURL(file).href;
    expect((await client({ url, keys: null }).refresh()).entries).toBe(1);
    expect((await client({ url }).refresh()).error).toBe('blocklist signature missing');
    writeFileSync(`${file}.sig`, sigFor(readFileSync(file, 'utf8')));
    expect((await client({ url }).refresh()).entries).toBe(1);
    expect((await client({ url, allowFileUrls: false }).refresh()).error).toMatch(
      /not allowed in production/,
    );
  });

  it('refresh is a no-op inside the TTL unless forced', async () => {
    publish([entry()]);
    const c = client();
    await c.refresh();
    publish([]);
    expect((await c.refresh()).entries).toBe(1);
    nowMs += 3_600_001;
    expect((await c.refresh()).entries).toBe(0);
    publish([entry()]);
    expect((await c.refresh()).entries).toBe(0);
    expect((await c.refresh(true)).entries).toBe(1);
  });

  it('warns once per TTL, not once per failed refresh', async () => {
    const c = client();
    await c.refresh();
    await c.refresh(true);
    await c.refresh(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: 'blocklist unavailable' }));
    nowMs += 3_600_001;
    await c.refresh(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
