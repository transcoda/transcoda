import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSession, bearer, createToken, HOST } from '../app/testing/http.ts';
import { fixturePluginPath } from '../plugins/testing/build.ts';
import {
  fedLibrary,
  json,
  library,
  outside,
  root,
  row,
  s,
  t,
  useRpcApp,
} from '../rpc/procedures/testing.ts';

useRpcApp({ devPlugins: () => [fixturePluginPath('trigger')] });

const IMPORT = '/api/triggers/trigger/import';

function hook(
  body: unknown,
  headers: Record<string, string>,
  opts: { path?: string; host?: string } = {},
): Promise<Response> {
  return Promise.resolve(
    t.app.request(opts.path ?? IMPORT, {
      method: 'POST',
      headers: { host: opts.host ?? HOST, 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

const basic = (password: string, user = 'sonarr') => ({
  authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
});

async function jobsToken(): Promise<string> {
  return (await createToken(t, s, { name: 'sonarr', scopes: ['jobs:create'] })).token;
}

type FileAnswer = {
  path: string;
  note: string;
  state: string;
  jobId: string | null;
  reason: string | null;
};
const filesOf = async (res: Response) => (await json<{ files: FileAnswer[] }>(res)).files;

const jobCount = () => (t.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n;

describe('POST /api/triggers/:plugin/:trigger', () => {
  it('queues a file inside a library through the workflow that feeds it', async () => {
    const { wf } = await fedLibrary();
    const res = await hook({ paths: [join(root, 'a.mkv')] }, basic(await jobsToken()));
    expect(res.status).toBe(200);
    const [file] = await filesOf(res);
    expect(file).toMatchObject({ path: join(root, 'a.mkv'), note: 'imported', reason: null });
    expect(file?.jobId).toEqual(expect.any(String));
    const job = row(file?.jobId as string);
    expect(job.workflowId).toBe(wf);
    expect(job.path).toMatch(/a\.mkv$/);
  });

  it('refuses paths outside every library, escaping through .. or a symlink, relative, or a folder', async () => {
    await fedLibrary();
    await mkdir(join(root, 'Show'), { recursive: true });
    await symlink(join(outside, 'x.mkv'), join(root, 'link.mkv'));
    const paths = [
      join(outside, 'x.mkv'),
      `${root}/../outside/x.mkv`,
      join(root, 'link.mkv'),
      'lib/a.mkv',
      join(root, 'Show'),
      join(root, 'missing.mkv'),
    ];
    const res = await hook({ paths }, basic(await jobsToken()));
    expect(res.status).toBe(200);
    const files = await filesOf(res);
    expect(files.map((f) => [f.state, f.reason, f.jobId])).toEqual([
      ['rejected', 'outside library root', null],
      ['rejected', 'outside library root', null],
      ['rejected', 'symlink escapes root', null],
      ['rejected', 'not an absolute path', null],
      ['rejected', 'not a file', null],
      ['rejected', 'not found', null],
    ]);
    expect(jobCount()).toBe(0);
  });

  it('a file in a library no active workflow feeds is refused', async () => {
    await library();
    const files = await filesOf(
      await hook({ paths: [join(root, 'a.mkv')] }, basic(await jobsToken())),
    );
    expect(files[0]).toMatchObject({
      state: 'rejected',
      reason: 'no active workflow feeds this library',
    });
    expect(jobCount()).toBe(0);
  });

  it('answers a test event and an ignored event without queueing', async () => {
    await fedLibrary();
    const token = await jobsToken();
    const test = await hook({ eventType: 'Test' }, basic(token));
    expect(test.status).toBe(200);
    expect(await test.json()).toEqual({ kind: 'test', message: 'test received' });
    const ignored = await hook({ eventType: 'Ignore', reason: 'a grab' }, basic(token));
    expect(await ignored.json()).toEqual({ kind: 'ignore', reason: 'a grab' });
    expect(jobCount()).toBe(0);
  });

  describe('authentication', () => {
    it('no credentials, a wrong token, or a malformed Basic header is 401 and queues nothing', async () => {
      await fedLibrary();
      const body = { paths: [join(root, 'a.mkv')] };
      const none = await hook(body, {});
      expect(none.status).toBe(401);
      expect(none.headers.get('www-authenticate')).toBe('Basic realm="transcoda"');
      expect((await hook(body, basic('tcd_wrong'))).status).toBe(401);
      expect((await hook(body, { authorization: 'Basic !!!' })).status).toBe(401);
      expect((await hook(body, { authorization: 'Basic' })).status).toBe(401);
      expect(jobCount()).toBe(0);
    });

    it('a signed-in session is not enough: triggers take tokens only', async () => {
      await fedLibrary();
      const res = await hook({ paths: [join(root, 'a.mkv')] }, asSession(s, true));
      expect(res.status).toBe(401);
      expect(jobCount()).toBe(0);
    });

    it('a token without jobs:create is 403', async () => {
      await fedLibrary();
      const { token } = await createToken(t, s, { name: 'r', scopes: ['read', 'plan'] });
      const res = await hook({ paths: [join(root, 'a.mkv')] }, basic(token));
      expect(res.status).toBe(403);
      expect(jobCount()).toBe(0);
    });

    it('a Bearer token works too, and a header trigger reads its own header', async () => {
      await fedLibrary();
      const token = await jobsToken();
      expect((await hook({ eventType: 'Test' }, bearer(token))).status).toBe(200);
      const keyed = '/api/triggers/trigger/keyed';
      expect(
        (await hook({ eventType: 'Test' }, { 'x-api-key': token }, { path: keyed })).status,
      ).toBe(200);
      expect(
        (await hook({ eventType: 'Test' }, { 'x-api-key': 'tcd_no' }, { path: keyed })).status,
      ).toBe(401);
    });

    it('the plugin never sees the credentials or the cookie', async () => {
      const token = await jobsToken();
      const res = await hook(
        { eventType: 'Headers' },
        { ...basic(token), cookie: 'tcd_session=x', 'x-api-key': token, 'x-sonarr': '1' },
      );
      const { message } = await json<{ message: string }>(res);
      expect(message.split(',')).toContain('x-sonarr');
      expect(message).not.toMatch(/authorization|cookie/);
      expect(message).not.toContain(token);
    });

    it('a host that is not allowed is refused before anything else', async () => {
      const res = await hook({ eventType: 'Test' }, basic(await jobsToken()), {
        host: 'evil.example',
      });
      expect(res.status).toBe(403);
    });
  });

  describe('untrusted input', () => {
    it('an unknown plugin or trigger is 404 once authenticated, 401 before', async () => {
      const token = await jobsToken();
      for (const path of ['/api/triggers/nope/import', '/api/triggers/trigger/nope']) {
        expect((await hook({}, basic(token), { path })).status).toBe(404);
        expect((await hook({}, {}, { path })).status).toBe(401);
      }
    });

    it('a body that is not JSON is 400', async () => {
      const res = await hook('{not json', basic(await jobsToken()));
      expect(res.status).toBe(400);
    });

    it('a plugin that answers nonsense or throws is 502 and queues nothing', async () => {
      await fedLibrary();
      const token = await jobsToken();
      const malformed = await hook({ eventType: 'Malformed', files: [{ path: 7 }] }, basic(token));
      expect(malformed.status).toBe(502);
      const tooMany = await hook(
        {
          eventType: 'Malformed',
          files: Array.from({ length: 101 }, () => ({ path: '/a', note: '' })),
        },
        basic(token),
      );
      expect(tooMany.status).toBe(502);
      const thrown = await hook({ eventType: 'Throw' }, basic(token));
      expect(thrown.status).toBe(502);
      expect(await thrown.json()).toMatchObject({
        message: expect.stringContaining('trigger exploded'),
      });
      expect(jobCount()).toBe(0);
    });

    it('a stopped plugin is 503', async () => {
      const token = await jobsToken();
      await t.deps.plugins.disable('trigger');
      const res = await hook({ eventType: 'Test' }, basic(token));
      expect(res.status).toBe(503);
    });
  });
});
