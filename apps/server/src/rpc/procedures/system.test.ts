import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LicencesOutputSchema } from '@transcoda/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.ts';
import { createTestApp, type TestApp } from '../../test-app.ts';
import { asSession, bearer, createToken, login, send } from '../../test-http.ts';

// The generator's own fixture (scripts/third-party-notices.test.ts writes and checks it).
const FIXTURE = new URL(
  '../../../../../scripts/fixtures/licences/expected-third-party.json',
  import.meta.url,
).pathname;

let t: TestApp | undefined;
const temp: string[] = [];

afterEach(async () => {
  await t?.close();
  t = undefined;
  for (const f of temp.splice(0)) rmSync(f, { force: true });
});

function quietLog() {
  const warn = vi.fn<Logger['warn']>();
  const log: Logger = { info: vi.fn(), warn, error: vi.fn() };
  return { log, warn };
}

function tempFile(body: string): string {
  const file = join(tmpdir(), `transcoda-third-party-${randomUUID()}.json`);
  writeFileSync(file, body);
  temp.push(file);
  return file;
}

describe('system.licences', () => {
  it('a session reads the generated list', async () => {
    t = createTestApp({ thirdPartyFile: FIXTURE });
    const s = await login(t);
    const res = await send(t, 'GET', '/system/licences', { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    const body = LicencesOutputSchema.parse(await res.json());
    if (!body.available) throw new Error('expected the list');
    expect(body.packages.map((p) => p.name)).toContain('jellyfin-ffmpeg');
    for (const p of body.packages) expect(body.texts[p.textKey]).toBeTypeOf('string');
  });

  it('a token with read may read', async () => {
    t = createTestApp({ thirdPartyFile: FIXTURE });
    const s = await login(t);
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const res = await send(t, 'GET', '/system/licences', { headers: bearer(token) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { available: boolean }).available).toBe(true);
  });

  it('missing file → available false, no warning', async () => {
    const { log, warn } = quietLog();
    t = createTestApp({ thirdPartyFile: join(tmpdir(), `missing-${randomUUID()}.json`), log });
    const s = await login(t);
    const res = await send(t, 'GET', '/system/licences', { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a garbage file → available false and a warning; fixing the file is picked up', async () => {
    const { log, warn } = quietLog();
    const file = tempFile('{"format": 1, "packages": "nope"');
    t = createTestApp({ thirdPartyFile: file, log });
    const s = await login(t);
    const res = await send(t, 'GET', '/system/licences', { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
    expect(warn).toHaveBeenCalledTimes(1);
    writeFileSync(file, readFileSync(FIXTURE, 'utf8'));
    const again = await send(t, 'GET', '/system/licences', { headers: asSession(s, false) });
    expect(((await again.json()) as { available: boolean }).available).toBe(true);
  });

  it('a file of the wrong shape → available false and one warning', async () => {
    const { log, warn } = quietLog();
    t = createTestApp({
      thirdPartyFile: tempFile('{"format": 2, "packages": [], "texts": {}}'),
      log,
    });
    const s = await login(t);
    const res = await send(t, 'GET', '/system/licences', { headers: asSession(s, false) });
    expect(await res.json()).toEqual({ available: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads the file once (the list is part of the build)', async () => {
    const file = tempFile(readFileSync(FIXTURE, 'utf8'));
    t = createTestApp({ thirdPartyFile: file });
    const s = await login(t);
    await send(t, 'GET', '/system/licences', { headers: asSession(s, false) });
    writeFileSync(file, 'garbage');
    const res = await send(t, 'GET', '/system/licences', { headers: asSession(s, false) });
    expect(((await res.json()) as { available: boolean }).available).toBe(true);
  });

  it('anonymous → 401', async () => {
    t = createTestApp({ thirdPartyFile: FIXTURE });
    expect((await send(t, 'GET', '/system/licences')).status).toBe(401);
  });
});

describe('system.gpuLoad', () => {
  it('serves the sampler snapshot: none without NVIDIA GPUs', async () => {
    t = createTestApp();
    const s = await login(t);
    const res = await send(t, 'GET', '/system/gpu-load', { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ intervalMs: 5000, gpus: [] });
  });

  it('anonymous → 401', async () => {
    t = createTestApp();
    expect((await send(t, 'GET', '/system/gpu-load')).status).toBe(401);
  });
});
