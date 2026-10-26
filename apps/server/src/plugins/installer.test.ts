import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Installer, MAX_BUNDLE_BYTES } from './installer.ts';
import type { SigningKey } from './signature.ts';
import { signText } from './testing/sign.ts';

const SDK = '1.0.0-rc.1';
const BUNDLE = Buffer.from('export default {};\n');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function manifest(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'example',
    version: '1.0.0',
    sdk: '^1',
    nodes: ['example:echo'],
    integration: null,
    triggers: [],
    hooks: [],
    ...over,
  });
}

describe('Installer', () => {
  let server: Server;
  let base = '';
  let manifestBody = manifest();
  let sigBody: string | null = null;
  let sigStatus = 200;
  let dir: string;
  let pluginsDir: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/b.js') res.end(BUNDLE);
      else if (req.url === '/chunked.js') {
        res.write(Buffer.alloc(8));
        res.write(Buffer.alloc(8));
        res.end(Buffer.alloc(8));
      } else if (req.url === '/m.json') res.end(manifestBody);
      else if (req.url === '/b.js.sig' && sigStatus !== 200) {
        res.statusCode = sigStatus;
        res.end();
      } else if (req.url === '/b.js.sig' && sigBody !== null) res.end(sigBody);
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  beforeEach(() => {
    manifestBody = manifest();
    sigBody = null;
    sigStatus = 200;
    dir = mkdtempSync(join(tmpdir(), 'tc-inst-'));
    pluginsDir = join(dir, 'plugins');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const installer = (): Installer => new Installer({ pluginsDir, token: null, allowHttp: true });
  const req = (over: Record<string, unknown> = {}) => ({
    name: 'example',
    version: '1.0.0',
    url: `${base}/b.js`,
    manifestUrl: `${base}/m.json`,
    sha256: sha(BUNDLE),
    size: BUNDLE.length,
    signature: null,
    keys: null,
    ...over,
  });

  it('download writes <name>-<version>.js and .manifest.json atomically and returns the manifest', async () => {
    const i = installer();
    const r = await i.download(req(), SDK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundlePath).toBe(join(pluginsDir, 'example-1.0.0.js'));
    expect(r.manifest.name).toBe('example');
    expect(readdirSync(pluginsDir).sort()).toEqual([
      'example-1.0.0.js',
      'example-1.0.0.manifest.json',
    ]);
    expect(await i.listInstalledFiles()).toEqual([
      'example-1.0.0.js',
      'example-1.0.0.manifest.json',
    ]);
    expect((await i.readManifest('example', '1.0.0')).nodes).toEqual(['example:echo']);
    expect(await i.verifyInstalled('example', '1.0.0', sha(BUNDLE), null)).toEqual({
      ok: true,
      bytes: BUNDLE,
      keyId: null,
    });
    expect(await i.verifyInstalled('example', '1.0.0', 'a'.repeat(64), null)).toEqual({
      ok: false,
      reason: 'bundle changed on disk; reinstall',
    });
    await i.remove('example', '1.0.0');
    await i.remove('example', '1.0.0');
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  it('fetchManifest reads and checks the manifest without writing anything', async () => {
    const i = installer();
    const ok = await i.fetchManifest(req(), SDK);
    expect(ok).toMatchObject({ ok: true, manifest: { name: 'example', version: '1.0.0' } });
    manifestBody = manifest({
      nodeVersions: [{ type: 'example:echo', version: 2, migrations: [] }],
    });
    expect(await i.fetchManifest(req(), SDK)).toMatchObject({
      ok: true,
      manifest: { nodeVersions: [{ type: 'example:echo', version: 2, migrations: [] }] },
    });
    expect(() => readdirSync(pluginsDir)).toThrow();
  });

  it('fetchManifest: a wrong name or version, an unsupported sdk or junk is reason manifest; an unreachable url is network', async () => {
    const i = installer();
    manifestBody = manifest({ version: '2.0.0' });
    expect(await i.fetchManifest(req(), SDK)).toMatchObject({ ok: false, reason: 'manifest' });
    manifestBody = manifest({ sdk: '^9' });
    expect(await i.fetchManifest(req(), SDK)).toMatchObject({
      ok: false,
      reason: 'manifest',
      message: expect.stringContaining('not supported'),
    });
    manifestBody = 'not json';
    expect(await i.fetchManifest(req(), SDK)).toMatchObject({ ok: false, reason: 'manifest' });
    manifestBody = manifest();
    expect(await i.fetchManifest(req({ manifestUrl: `${base}/missing.json` }), SDK)).toMatchObject({
      ok: false,
      reason: 'network',
    });
    expect(
      await new Installer({ pluginsDir, token: null }).fetchManifest(req(), SDK),
    ).toMatchObject({ ok: false, reason: 'network', message: 'plugin urls must be https' });
  });

  it('fetchManifest stops when its signal aborts: the request is cancelled, not left running', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const i = new Installer({
      pluginsDir,
      token: null,
      allowHttp: true,
      fetchFn: (async (_url: string, init?: RequestInit) => {
        seen.push(init?.signal ?? undefined);
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      }) as typeof fetch,
    });
    const ac = new AbortController();
    const pending = i.fetchManifest(req(), SDK, ac.signal);
    ac.abort();
    expect(await pending).toMatchObject({ ok: false, reason: 'network' });
    expect(seen[0]?.aborted).toBe(true);
  });

  it('verifyInstalled refuses a missing file and a symlink in place of the bundle', async () => {
    const i = installer();
    const reason = { ok: false, reason: 'bundle changed on disk; reinstall' };
    mkdirSync(pluginsDir, { recursive: true });
    expect(await i.verifyInstalled('example', '1.0.0', sha(BUNDLE), null)).toEqual(reason);
    writeFileSync(join(dir, 'real.js'), BUNDLE);
    symlinkSync(join(dir, 'real.js'), join(pluginsDir, 'example-1.0.0.js'));
    expect(await i.verifyInstalled('example', '1.0.0', sha(BUNDLE), null)).toEqual(reason);
  });

  describe('staging for the plugin user', () => {
    let runDir: string;
    beforeEach(() => {
      runDir = join(dir, 'run');
      mkdirSync(runDir);
    });

    it('stage writes <runDir>/<name>-<version>.js with mode 0640 and returns the real path', async () => {
      const i = installer();
      const path = await i.stage('example', '1.0.0', BUNDLE, runDir);
      expect(path).toBe(join(realpathSync(runDir), 'example-1.0.0.js'));
      expect(readFileSync(path)).toEqual(BUNDLE);
      expect(statSync(path).mode & 0o777).toBe(0o640);
      expect(readdirSync(runDir)).toEqual(['example-1.0.0.js']);
    });

    it('stage replaces an existing file by rename and leaves no temporary file', async () => {
      const i = installer();
      await i.stage('example', '1.0.0', Buffer.from('old'), runDir);
      const path = await i.stage('example', '1.0.0', BUNDLE, runDir);
      expect(readFileSync(path)).toEqual(BUNDLE);
      expect(readdirSync(runDir)).toEqual(['example-1.0.0.js']);
    });

    it('stage refuses an invalid name or version and a missing run dir', async () => {
      const i = installer();
      await expect(i.stage('../x', '1.0.0', BUNDLE, runDir)).rejects.toThrow(/invalid plugin name/);
      await expect(i.stage('example', '../1', BUNDLE, runDir)).rejects.toThrow(
        /invalid plugin version/,
      );
      await expect(i.stage('example', '1.0.0', BUNDLE, join(dir, 'nope'))).rejects.toThrow(
        /ENOENT/,
      );
    });

    it('unstage removes one file (best effort, twice is fine); cleanRunDir empties the directory', async () => {
      const i = installer();
      await i.stage('example', '1.0.0', BUNDLE, runDir);
      await i.stage('example', '1.1.0', BUNDLE, runDir);
      await i.unstage('example', '1.0.0', runDir);
      await i.unstage('example', '1.0.0', runDir);
      await i.unstage('example', '9.9.9', join(dir, 'nope'));
      expect(readdirSync(runDir)).toEqual(['example-1.1.0.js']);
      writeFileSync(join(runDir, '.tmp-leftover'), 'x');
      await i.cleanRunDir(runDir);
      expect(readdirSync(runDir)).toEqual([]);
      await i.cleanRunDir(join(dir, 'nope'));
    });

    it('cleanRunDir removes only staged bundles and .tmp-* files, never anything else', async () => {
      const i = installer();
      for (const n of [
        'example-1.0.0.js',
        'example-1.0.0-beta.1.js',
        '.tmp-abc',
        'transcoda.sqlite',
        'secret.key',
        'notes.txt',
        'example-1.0.0.manifest.json',
        'Bad_Name-1.0.js',
      ])
        writeFileSync(join(runDir, n), 'x');
      await i.cleanRunDir(runDir);
      expect(readdirSync(runDir).sort()).toEqual([
        'Bad_Name-1.0.js',
        'example-1.0.0.manifest.json',
        'notes.txt',
        'secret.key',
        'transcoda.sqlite',
      ]);
    });
  });

  it('refuses a checksum mismatch, a body larger than size, a manifest whose version differs, and an sdk range this server does not satisfy', async () => {
    const i = installer();
    const bad = await i.download(req({ sha256: 'b'.repeat(64) }), SDK);
    expect(bad).toMatchObject({ ok: false, reason: 'checksum' });
    if (!bad.ok)
      expect(bad.message).toMatch(/^checksum mismatch: expected b{64}, got [0-9a-f]{64}$/);

    expect(await i.download(req({ size: BUNDLE.length - 1 }), SDK)).toMatchObject({
      ok: false,
      reason: 'too-large',
    });
    expect(await i.download(req({ size: MAX_BUNDLE_BYTES + 1 }), SDK)).toMatchObject({
      ok: false,
      reason: 'too-large',
    });

    manifestBody = manifest({ version: '1.0.1' });
    expect(await i.download(req(), SDK)).toMatchObject({ ok: false, reason: 'manifest' });
    manifestBody = 'not json';
    expect(await i.download(req(), SDK)).toMatchObject({ ok: false, reason: 'manifest' });

    manifestBody = manifest({ sdk: '^2' });
    expect(await i.download(req(), SDK)).toEqual({
      ok: false,
      reason: 'sdk',
      message: 'sdk ^2 is not supported by this server (sdk 1.0.0-rc.1)',
    });

    manifestBody = manifest();
    expect(await i.download(req({ url: `${base}/missing` }), SDK)).toMatchObject({
      ok: false,
      reason: 'network',
    });
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  it('accepts a prerelease sdk against ^1 (includePrerelease)', async () => {
    expect((await installer().download(req(), '1.0.0-rc.1')).ok).toBe(true);
  });

  it('refuses to install over an existing file or a symlink and never follows a symlinked pluginsDir', async () => {
    const i = installer();
    expect((await i.download(req(), SDK)).ok).toBe(true);
    expect(await i.download(req(), SDK)).toMatchObject({ ok: false, reason: 'exists' });

    symlinkSync('/etc/hosts', join(pluginsDir, 'example-2.0.0.js'));
    manifestBody = manifest({ version: '2.0.0' });
    expect(await i.download(req({ version: '2.0.0' }), SDK)).toMatchObject({
      ok: false,
      reason: 'symlink',
    });

    const real = join(dir, 'real');
    mkdirSync(real);
    const linked = join(dir, 'linked');
    symlinkSync(real, linked);
    const li = new Installer({ pluginsDir: linked, token: null, allowHttp: true });
    await expect(li.ensureDir()).rejects.toThrow(/symlink/);
    expect(await li.download(req(), SDK)).toMatchObject({ ok: false, reason: 'symlink' });
    expect(readdirSync(real)).toEqual([]);
  });

  it('refuses path traversal through name or version, for every entry point', async () => {
    const i = installer();
    await i.ensureDir();
    const evil = [
      '/../../../evil',
      '../x',
      '1.0.0/../../x',
      '1.0',
      'v1.0.0',
      '1.0.0\0',
      '1.0.0+../../x',
      '1.0.0-..',
      '..\\x',
      '1.0.0\u2215x',
    ];
    for (const version of evil) {
      expect(await i.download(req({ version }), SDK)).toMatchObject({
        ok: false,
        reason: 'manifest',
      });
      await expect(i.remove('example', version)).rejects.toThrow(/invalid plugin version/);
      await expect(i.readManifest('example', version)).rejects.toThrow(/invalid plugin version/);
      await expect(i.verifyInstalled('example', version, 'a'.repeat(64), null)).rejects.toThrow(
        /invalid plugin version/,
      );
      expect(() => i.bundlePath('example', version)).toThrow();
      expect(() => i.manifestPath('example', version)).toThrow();
    }
    for (const name of ['../x', 'a/b', 'catalog', 'catalogs', 'Example', '']) {
      expect(await i.download(req({ name }), SDK)).toMatchObject({ ok: false, reason: 'manifest' });
      expect(() => i.bundlePath(name, '1.0.0')).toThrow(/invalid plugin name/);
    }
    expect(readdirSync(pluginsDir)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['plugins']);
  });

  it('refuses an over-long version with a clear manifest failure', async () => {
    const i = installer();
    const version = `1.0.0-${'a'.repeat(70)}`;
    const r = await i.download(req({ version }), SDK);
    expect(r).toMatchObject({ ok: false, reason: 'manifest' });
    if (!r.ok) expect(r.message).toBe('plugin version is longer than 64 characters');
    expect(() => i.bundlePath('example', version)).toThrow(/longer than 64/);
  });

  it('refuses plain http urls unless allowHttp', async () => {
    const strict = new Installer({ pluginsDir, token: null });
    expect(await strict.download(req(), SDK)).toMatchObject({ ok: false, reason: 'network' });
  });

  it('enforces the size cap on chunked bodies and on a declared content-length', async () => {
    const i = installer();
    expect(
      await i.download(req({ url: `${base}/chunked.js`, size: 20, sha256: 'a'.repeat(64) }), SDK),
    ).toMatchObject({ ok: false, reason: 'too-large' });
    expect(await i.download(req({ size: 5 }), SDK)).toMatchObject({
      ok: false,
      reason: 'too-large',
    });
    expect(readdirSync(pluginsDir)).toEqual([]);
  });

  it('a failed install leaves an existing install untouched', async () => {
    const i = installer();
    expect((await i.download(req(), SDK)).ok).toBe(true);
    const before = readFileSync(join(pluginsDir, 'example-1.0.0.js'));
    const mBefore = readFileSync(join(pluginsDir, 'example-1.0.0.manifest.json'));
    expect(await i.download(req(), SDK)).toMatchObject({ ok: false, reason: 'exists' });
    expect(await i.download(req({ sha256: 'c'.repeat(64) }), SDK)).toMatchObject({ ok: false });
    expect(readFileSync(join(pluginsDir, 'example-1.0.0.js')).equals(before)).toBe(true);
    expect(readFileSync(join(pluginsDir, 'example-1.0.0.manifest.json')).equals(mBefore)).toBe(
      true,
    );
    expect(readdirSync(pluginsDir).sort()).toEqual([
      'example-1.0.0.js',
      'example-1.0.0.manifest.json',
    ]);
  });

  it('serialises concurrent installs of the same name@version: one wins, one reports exists', async () => {
    const i = installer();
    const [a, b] = await Promise.all([i.download(req(), SDK), i.download(req(), SDK)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(readdirSync(pluginsDir).filter((f) => f.startsWith('.tmp-'))).toEqual([]);
  });

  it('readManifest refuses a manifest that does not match its file name', async () => {
    const i = installer();
    await i.ensureDir();
    writeFileSync(join(pluginsDir, 'example-1.0.0.manifest.json'), manifest({ name: 'other' }));
    await expect(i.readManifest('example', '1.0.0')).rejects.toThrow(/describes other@1\.0\.0/);
  });

  it('the token goes only to GitHub hosts, also across redirects', async () => {
    const seen: Array<{ host: string; auth: string | undefined }> = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const h = new Headers(init?.headers);
      seen.push({ host: u.hostname, auth: h.get('authorization') ?? undefined });
      if (u.hostname === 'objects.githubusercontent.com' && u.pathname === '/m.json') {
        return new Response(manifestBody);
      }
      if (u.pathname === '/m.json') return new Response(manifestBody);
      if (u.hostname === 'github.com') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example.org/b.js' },
        });
      }
      return new Response(BUNDLE);
    }) as typeof fetch;
    const i = new Installer({ pluginsDir, token: 'tok', fetchFn });
    const r = await i.download(
      req({
        url: 'https://github.com/x/b.js',
        manifestUrl: 'https://plugins.example.org/m.json',
      }),
      SDK,
    );
    expect(r.ok).toBe(true);
    expect(seen).toEqual([
      { host: 'plugins.example.org', auth: undefined },
      { host: 'github.com', auth: 'Bearer tok' },
      { host: 'evil.example.org', auth: undefined },
    ]);
  });

  it('creates the directory with mode 0700', async () => {
    await installer().ensureDir();
    expect(statSync(pluginsDir).mode & 0o777).toBe(0o700);
  });

  it('audit names a symlink and a stray directory', async () => {
    const i = installer();
    await i.ensureDir();
    symlinkSync('/etc/hosts', join(pluginsDir, 'evil-1.0.0.js'));
    mkdirSync(join(pluginsDir, 'stray'));
    writeFileSync(join(pluginsDir, 'example-1.0.0.js'), BUNDLE);
    writeFileSync(join(pluginsDir, 'example-1.0.0.manifest.json'), manifest());
    writeFileSync(join(pluginsDir, 'orphan-1.0.0.js'), BUNDLE);
    const msgs = await i.audit();
    expect(msgs).toHaveLength(4);
    expect(msgs.join('\n')).toMatch(/orphan-1\.0\.0\.js has no manifest/);
    expect(msgs.join('\n')).toMatch(/evil-1\.0\.0\.js is a symlink/);
    expect(msgs.join('\n')).toMatch(/stray is a directory/);
    expect(await i.listInstalledFiles()).toEqual([
      'example-1.0.0.js',
      'example-1.0.0.manifest.json',
      'orphan-1.0.0.js',
    ]);
  });

  it('an HTTP/1.0 close-delimited host (raw TCP, no content-length) cannot crash the process: a normal network failure, no .tmp left', async () => {
    const body = Buffer.alloc(256 * 1024, 7);
    const tcp = createTcpServer((sock) => {
      sock.on('error', () => undefined);
      sock.once('data', () => {
        sock.write('HTTP/1.0 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n');
        let sent = 0;
        const tick = (): void => {
          if (sent >= body.length) return void sock.end();
          sock.write(body.subarray(sent, sent + 16 * 1024));
          sent += 16 * 1024;
          setTimeout(tick, 2);
        };
        tick();
      });
    });
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
    const port = (tcp.address() as AddressInfo).port;
    try {
      const r = await installer().download(
        req({ url: `http://127.0.0.1:${port}/b.js`, size: body.length }),
        SDK,
      );
      expect(r).toMatchObject({ ok: false });
      expect(readdirSync(pluginsDir).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
    } finally {
      await new Promise<void>((r) => tcp.close(() => r()));
    }
  });

  it('a garbage (non-HTTP) answer is a network failure', async () => {
    const tcp = createTcpServer((sock) => {
      sock.on('error', () => undefined);
      sock.once('data', () => sock.end('this is not http\r\n\r\n'));
    });
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
    const port = (tcp.address() as AddressInfo).port;
    try {
      expect(
        await installer().download(req({ manifestUrl: `http://127.0.0.1:${port}/m.json` }), SDK),
      ).toMatchObject({ ok: false, reason: 'network' });
    } finally {
      await new Promise<void>((r) => tcp.close(() => r()));
    }
  });

  describe('bundle signatures', () => {
    let privateKey: KeyObject;
    let keys: SigningKey[];
    const goodSig = (): string => signText(BUNDLE, privateKey, 'k1');
    const signed = (over: Record<string, unknown> = {}) =>
      req({ signature: `${base}/b.js.sig`, keys, ...over });
    beforeEach(() => {
      const pair = generateKeyPairSync('ed25519');
      privateKey = pair.privateKey;
      const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
      keys = [{ id: 'k1', publicKey: spki.subarray(spki.length - 32).toString('hex') }];
      sigBody = goodSig();
    });

    it('a signed download stores <name>-<version>.js.sig (0600) and reports the key', async () => {
      const i = installer();
      const r = await i.download(signed(), SDK);
      expect(r).toMatchObject({ ok: true, signedBy: 'k1' });
      expect(readdirSync(pluginsDir).sort()).toEqual([
        'example-1.0.0.js',
        'example-1.0.0.js.sig',
        'example-1.0.0.manifest.json',
      ]);
      expect(readFileSync(join(pluginsDir, 'example-1.0.0.js.sig'), 'utf8')).toBe(sigBody);
      expect(statSync(join(pluginsDir, 'example-1.0.0.js.sig')).mode & 0o777).toBe(0o600);
      expect(await i.listInstalledFiles()).toContain('example-1.0.0.js.sig');
      expect(await i.audit()).toEqual([]);
      await i.remove('example', '1.0.0');
      expect(readdirSync(pluginsDir)).toEqual([]);
    });

    it('an unsigned download (no keys) stores no signature and reports signedBy null', async () => {
      const r = await installer().download(req({ signature: `${base}/b.js.sig` }), SDK);
      expect(r).toMatchObject({ ok: true, signedBy: null });
      expect(readdirSync(pluginsDir)).not.toContain('example-1.0.0.js.sig');
    });

    it('a signature that answers 404 is signature / "signature missing (HTTP 404)", nothing written', async () => {
      sigBody = null;
      const r = await installer().download(signed(), SDK);
      expect(r).toEqual({
        ok: false,
        reason: 'signature',
        message: 'bundle signature invalid: signature missing (HTTP 404)',
      });
      expect(readdirSync(pluginsDir)).toEqual([]);
    });

    it('a signature by another key, over other bytes or malformed is refused before anything is stored', async () => {
      sigBody = signText(BUNDLE, generateKeyPairSync('ed25519').privateKey, 'k1');
      expect(await installer().download(signed(), SDK)).toEqual({
        ok: false,
        reason: 'signature',
        message: 'bundle signature invalid: signature does not match',
      });
      sigBody = signText(Buffer.from('other'), privateKey, 'k1');
      expect(await installer().download(signed(), SDK)).toMatchObject({
        ok: false,
        reason: 'signature',
      });
      sigBody = signText(BUNDLE, privateKey, 'k9');
      expect(await installer().download(signed(), SDK)).toMatchObject({
        ok: false,
        reason: 'signature',
        message: 'bundle signature invalid: signed with an unknown key k9',
      });
      sigBody = 'not json';
      expect(await installer().download(signed(), SDK)).toMatchObject({
        ok: false,
        reason: 'signature',
        message: expect.stringContaining('malformed signature file'),
      });
      expect(readdirSync(pluginsDir)).toEqual([]);
    });

    it('an oversized .sig is signature / invalid, nothing stored', async () => {
      sigBody = 'x'.repeat(16 * 1024 + 1);
      expect(await installer().download(signed(), SDK)).toMatchObject({
        ok: false,
        reason: 'signature',
        message: expect.stringContaining('bundle signature invalid: malformed signature file'),
      });
      expect(readdirSync(pluginsDir)).toEqual([]);
    });

    it('a 5xx on the .sig is a network failure, not a missing signature', async () => {
      sigStatus = 503;
      expect(await installer().download(signed(), SDK)).toEqual({
        ok: false,
        reason: 'network',
        message: 'download failed: HTTP 503',
      });
      expect(readdirSync(pluginsDir)).toEqual([]);
    });

    it('a stray .js.sig already in the directory is "exists" and is not overwritten', async () => {
      mkdirSync(pluginsDir, { recursive: true });
      writeFileSync(join(pluginsDir, 'example-1.0.0.js.sig'), 'stray');
      const r = await installer().download(signed(), SDK);
      expect(r).toMatchObject({ ok: false, reason: 'exists' });
      expect(readFileSync(join(pluginsDir, 'example-1.0.0.js.sig'), 'utf8')).toBe('stray');
      expect(readdirSync(pluginsDir)).toEqual(['example-1.0.0.js.sig']);
    });

    it('keys without a signature url refuse the version', async () => {
      expect(await installer().download(signed({ signature: null }), SDK)).toEqual({
        ok: false,
        reason: 'signature',
        message: 'the catalog is signed but this version has no bundle signature',
      });
    });

    it('verifyInstalled checks the stored signature before every start', async () => {
      const i = installer();
      await i.download(signed(), SDK);
      const sigFile = join(pluginsDir, 'example-1.0.0.js.sig');
      expect(await i.verifyInstalled('example', '1.0.0', sha(BUNDLE), keys)).toEqual({
        ok: true,
        bytes: BUNDLE,
        keyId: 'k1',
      });
      // keys === null: an unsigned install does not look at the signature at all
      expect(await i.verifyInstalled('example', '1.0.0', sha(BUNDLE), null)).toMatchObject({
        ok: true,
        keyId: null,
      });
      // a key list without the id, and an empty list, both mean "unknown key"
      const unknown = {
        ok: false,
        reason: 'signed with an unknown key k1; update the plugin',
      };
      expect(await i.verifyInstalled('example', '1.0.0', sha(BUNDLE), [])).toEqual(unknown);
      expect(
        await i.verifyInstalled('example', '1.0.0', sha(BUNDLE), [
          { id: 'k2', publicKey: keys[0]?.publicKey ?? '' },
        ]),
      ).toEqual(unknown);
      // Review focus 3: the .sig deleted: never started on the checksum alone
      writeFileSync(`${sigFile}.bak`, readFileSync(sigFile));
      rmSync(sigFile);
      expect(await i.verifyInstalled('example', '1.0.0', sha(BUNDLE), keys)).toEqual({
        ok: false,
        reason: 'bundle signature missing; reinstall',
      });
      // a corrupt .sig
      writeFileSync(sigFile, '{"schema":1');
      expect(await i.verifyInstalled('example', '1.0.0', sha(BUNDLE), keys)).toEqual({
        ok: false,
        reason: 'bundle signature invalid; reinstall',
      });
      // a signature that does not match the bytes on disk
      writeFileSync(sigFile, signText(Buffer.from('x'), privateKey, 'k1'));
      expect(await i.verifyInstalled('example', '1.0.0', sha(BUNDLE), keys)).toEqual({
        ok: false,
        reason: 'bundle signature invalid; reinstall',
      });
      // a directory or symlink in place of the .sig
      rmSync(sigFile);
      symlinkSync(`${sigFile}.bak`, sigFile);
      expect(await i.verifyInstalled('example', '1.0.0', sha(BUNDLE), keys)).toEqual({
        ok: false,
        reason: 'bundle signature invalid; reinstall',
      });
    });

    it('a changed bundle is still "bundle changed on disk" with keys', async () => {
      const i = installer();
      await i.download(signed(), SDK);
      expect(await i.verifyInstalled('example', '1.0.0', 'a'.repeat(64), keys)).toEqual({
        ok: false,
        reason: 'bundle changed on disk; reinstall',
      });
    });

    it('audit reports an orphan .js.sig', async () => {
      const i = installer();
      await i.ensureDir();
      writeFileSync(join(pluginsDir, 'x-1.0.0.js.sig'), sigBody ?? '');
      expect(await i.audit()).toEqual(['x-1.0.0.js.sig has no bundle']);
    });
  });

  it('audit removes stale .tmp-* files', async () => {
    const i = installer();
    await i.ensureDir();
    writeFileSync(join(pluginsDir, '.tmp-abc123'), 'x');
    await i.audit();
    expect(readdirSync(pluginsDir)).toEqual([]);
  });
});
