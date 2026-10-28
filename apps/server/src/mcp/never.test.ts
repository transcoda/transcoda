import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import { isFinalState, type JobState, type JsonValue, type WorkflowGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exec } from '../capabilities/ffmpeg.ts';
import { findJob, listRecycled } from '../db/repos/jobs.ts';
import { tempDir } from '../engine/fixtures.ts';
import { type FsOps, nodeFsOps } from '../engine/fs-ops.ts';
import { FakeSpawner } from '../engine/process.ts';
import type { Logger } from '../logger.ts';
import { createTestApp, type TestApp } from '../test-app.ts';
import { asSession, bearer, createToken, login, type Session, send } from '../test-http.ts';
import { CorruptGraphError } from '../workflows/service.ts';
import { chain, childGraph, node } from '../workflows/test-helpers.ts';
import { mcpClient } from './test-client.ts';
import { ALL_TOOLS } from './tools/index.ts';

vi.setConfig({ testTimeout: 30_000 });

const SECRET = 'hook-secret-7f3a';

const EXPECTED_TOOLS = [
  'queue_status',
  'pause_queue',
  'resume_queue',
  'list_jobs',
  'get_job',
  'get_job_log',
  'pause_job',
  'resume_job',
  'cancel_job',
  'cancel_all_jobs',
  'list_workflows',
  'get_workflow',
  'list_workflow_versions',
  'list_nodes',
  'validate_workflow',
  'create_workflow',
  'save_workflow',
  'duplicate_workflow',
  'rename_workflow',
  'delete_workflow',
  'list_libraries',
  'browse_library',
  'list_runs',
  'get_run',
  'dry_run',
  'list_plugins',
];

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '9.0.2',
  encoders: ['aac', 'libx264', 'libx265'],
  hwaccels: [],
  filters: ['pan'],
};

const exec: Exec = async (_file, args) => {
  if (args.includes('-show_format')) {
    const json = {
      format: {
        format_name: 'matroska,webm',
        duration: '60.000000',
        size: '1000',
        start_time: '0.000000',
      },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          // The encode output (in the transcode dir) is h264, as the test-encode workflow asks.
          codec_name: String(args.at(-1)).includes('/transcode/') ? 'h264' : 'hevc',
          disposition: { default: 1 },
        },
        {
          index: 1,
          codec_type: 'audio',
          codec_name: 'aac',
          disposition: { default: 1 },
          tags: { language: 'eng' },
        },
      ],
    };
    return { stdout: JSON.stringify(json), stderr: '' };
  }
  if (args.includes('packet=pts_time,duration_time')) return { stdout: '59.96,0.04\n', stderr: '' };
  if (args.includes('-read_intervals')) return { stdout: '55.0,1000,K__\n', stderr: '' };
  return { stdout: '', stderr: '' };
};

const fsOps: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) };

const text = (res: unknown) =>
  ((res as { content?: { text: string }[] }).content ?? [])[0]?.text ?? '';

const plain = (): WorkflowGraph =>
  chain('workflow', node('in', 'core:input-manual'), node('ro', 'core:replace-original'));

let base: string;
let file: string;
let t: TestApp;
let s: Session;
let logLines: string[];
let token: string;
let plainId: string;
let hookId: string;
let subId: string;
let spawner: FakeSpawner;

const hookGraph = (): WorkflowGraph =>
  chain(
    'workflow',
    node('in', 'core:input-manual'),
    node('run', 'core:run-subworkflow', {
      subworkflowId: subId,
      version: 1,
      overrides: { 'n.url': `https://h/p?k=${SECRET}`, 'media.base': `http://srv/x?k=${SECRET}` },
    } as JsonValue),
    node('ro', 'core:replace-original'),
    node('n', 'core:notify-webhook', {
      url: `https://hooks.example/t?token=${SECRET}`,
    } as JsonValue),
  );

beforeEach(async () => {
  spawner = new FakeSpawner();
  base = await tempDir('mcp-never-');
  const root = join(base, 'lib');
  await mkdir(root, { recursive: true });
  file = join(root, 'a.mkv');
  await writeFile(file, Buffer.alloc(1000, 7));
  logLines = [];
  const log: Logger = {
    info: (e) => void logLines.push(JSON.stringify(e)),
    warn: (e) => void logLines.push(JSON.stringify(e)),
    error: (e) => void logLines.push(JSON.stringify(e)),
  };
  t = createTestApp({
    config: {
      configDir: join(base, 'config'),
      transcodeDir: join(base, 'transcode'),
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
    },
    capabilities: caps,
    spawner,
    fsOps,
    exec,
    heartbeatMs: 10,
    log,
  });
  await t.deps.engine.start();
  s = await login(t);
  const lib = await send(t, 'POST', '/libraries', {
    body: { name: 'TV', path: root },
    headers: asSession(s, true),
  });
  expect(lib.status).toBe(200);
  ({ token } = await createToken(t, s, {
    name: 'all',
    scopes: ['read', 'plan', 'jobs:create', 'jobs:manage', 'workflows:write'],
  }));

  plainId = t.deps.workflows.create({ name: 'Plain', kind: 'workflow', graph: plain() }, 'u').id;
  subId = t.deps.workflows.create(
    { name: 'Sub', kind: 'subworkflow', graph: childGraph() },
    'u',
  ).id;
  hookId = t.deps.workflows.create({ name: 'Hook', kind: 'workflow', graph: hookGraph() }, 'u').id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await t.deps.engine.stop();
  await rm(base, { recursive: true, force: true });
});

const activeOf = () => new Map(t.deps.workflows.list().map((w) => [w.id, w.active]));
/** Every workflow that existed at `before` is unchanged; any other one is not active. */
const unchanged = (before: Map<string, unknown>): void => {
  const now = activeOf();
  for (const [id, active] of now) {
    expect(active, id).toEqual(before.has(id) ? before.get(id) : null);
  }
  for (const id of before.keys()) {
    if (!now.has(id)) throw new Error(`workflow ${id} disappeared`);
  }
};

describe('never tests', () => {
  it('a token with every scope sees exactly the 26 tools, every one annotated openWorldHint false; initialize carries the instructions', async () => {
    const client = await mcpClient(t, token);
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(tools.every((x) => x.annotations?.openWorldHint === false)).toBe(true);
    expect(client.getInstructions()).toContain('You can never activate a workflow version');
    expect(client.getInstructions()).toContain('never install, change or configure them');
    expect(ALL_TOOLS.map((d) => d.name)).toHaveLength(new Set(ALL_TOOLS.map((d) => d.name)).size);
    expect(ALL_TOOLS).toHaveLength(26);
  });

  it('no tool can activate, deactivate or change a mode; no real run is ever queued', async () => {
    const client = await mcpClient(t, token);
    const { tools } = await client.listTools();
    expect(tools.filter((x) => /enable|mode|activ|real/i.test(x.name))).toEqual([]);
    expect(ALL_TOOLS.filter((d) => /enable|mode|activ|real/i.test(d.name))).toEqual([]);

    for (const name of [
      'set_workflow_mode',
      'enable_workflow',
      'activate_workflow',
      'deactivate_workflow',
    ]) {
      const res = await client.callTool({ name, arguments: { id: plainId } });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/not found/);
      expect(res.structuredContent).toBeUndefined();
    }

    // Version 1 of the plain workflow is the one running for real.
    expect(t.deps.workflows.activate(plainId, 1, 'u').kind).toBe('ok');
    const before = activeOf();
    expect(before.get(plainId)).toMatchObject({ version: 1 });
    expect(before.get(hookId)).toBeNull();

    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, `${name}: ${text(res)}`).toBeFalsy();
      unchanged(before);
      return res.structuredContent as Record<string, unknown>;
    };

    const created = await call('create_workflow', {
      name: 'Made',
      kind: 'workflow',
      graph: plain(),
    });
    const createdId = created.id as string;
    expect(created.active).toBeNull();
    const saved = await call('save_workflow', {
      id: plainId,
      baseVersion: 1,
      graph: plain(),
    });
    expect(saved.version).toBe(2);
    expect(saved.active).toMatchObject({ version: 1 });
    const dup = await call('duplicate_workflow', { id: plainId, name: 'Copy' });
    expect(dup.active).toBeNull();
    await call('rename_workflow', { id: createdId, name: 'Renamed' });
    await call('delete_workflow', { id: createdId });
    const dry = await call('dry_run', { path: file, workflowId: plainId, force: true });
    expect(dry.dryRun).toBe(true);

    // Asking for a real run through extra arguments is refused, naming the key; nothing is queued.
    const sneaky = await client.callTool({
      name: 'dry_run',
      arguments: { path: file, workflowId: plainId, dryRun: false, force: true, mode: 'enabled' },
    });
    expect(sneaky.isError).toBe(true);
    expect(text(sneaky)).toMatch(/Input validation error[\s\S]*dryRun/);
    expect(sneaky.structuredContent).toBeUndefined();
    unchanged(before);

    const runs = await client.callTool({ name: 'list_runs', arguments: { limit: 200 } });
    const brief = runs.structuredContent as { runs: { dryRun: boolean }[] };
    expect(brief.runs.length).toBeGreaterThan(0);
    expect(brief.runs.every((r) => r.dryRun)).toBe(true);

    // B4: the previously activated version keeps running for real.
    const real = await t.deps.engine.queue.queue({
      path: file,
      workflowId: plainId,
      dryRun: false,
      force: true,
      priority: 0,
      createdBy: 'u',
    });
    if (real.kind !== 'queued') throw new Error(`expected queued, got ${real.kind}`);
    expect(real.run).toMatchObject({ workflowVersion: 1, dryRun: false });
    // A workflow nobody activated falls back to a dry run.
    const none = await t.deps.engine.queue.queue({
      path: file,
      workflowId: dup.id as string,
      dryRun: false,
      force: true,
      priority: 0,
      createdBy: 'u',
    });
    if (none.kind !== 'queued') throw new Error(`expected queued, got ${none.kind}`);
    expect(none.run).toMatchObject({ dryRun: true, note: 'no active version' });
  });

  it('plugins: only list_plugins exists; no tool installs, configures, removes, toggles or reads a catalog, and the API behind it refuses a token', async () => {
    const client = await mcpClient(t, token);
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name);
    expect(names).toContain('list_plugins');
    expect(
      names.filter((n) => /install|plugin.*(settings|remove|enable|disable)|catalog/i.test(n)),
    ).toEqual([]);
    expect(names.filter((n) => /install|settings|secret|plugin_(?!list)|catalog/i.test(n))).toEqual(
      [],
    );
    expect(ALL_TOOLS.map((d) => d.name).filter((n) => /plugin/.test(n))).toEqual(['list_plugins']);

    for (const name of [
      'install_plugin',
      'update_plugin',
      'update_check',
      'check_plugin_update',
      'remove_plugin',
      'enable_plugin',
      'disable_plugin',
      'restart_plugin',
      'save_plugin_settings',
      'get_plugin_settings',
      'test_plugin_settings',
      'list_plugin_catalog',
      'add_plugin_catalog',
      'regenerate_trigger_secret',
    ]) {
      const res = await client.callTool({ name, arguments: { name: 'example' } });
      expect(res.isError, name).toBe(true);
      expect(text(res), name).toMatch(/not found/);
      expect(res.structuredContent).toBeUndefined();
    }

    // The all-scopes token is refused by the API itself, not only by the tools' absence.
    for (const [method, path] of [
      ['GET', '/plugins/example/settings'],
      ['GET', '/plugins/catalog'],
      ['GET', '/plugins/example'],
    ] as const) {
      const res = await send(t, method, path, { headers: bearer(token) });
      expect(res.status, path).toBe(403);
    }
    // The update pre-check is a UI action as well: no tool, and a token on the route is refused.
    const check = await send(t, 'POST', '/plugins/example/update-check', {
      headers: bearer(token),
      body: { version: '1.0.0' },
    });
    expect(check.status).toBe(403);
  });

  it('folder browsing: no tool lists server folders, and the API behind it refuses the all-scopes token', async () => {
    const client = await mcpClient(t, token);
    const { tools } = await client.listTools();
    expect(
      tools
        .map((x) => x.name)
        .filter((n) =>
          /browse_dirs|browse_folders|list_folders|fs_|filesystem|directories/i.test(n),
        ),
    ).toEqual([]);
    // `browse_library` is the only browse tool: it lists inside a library root, not the server.
    expect(ALL_TOOLS.map((d) => d.name).filter((n) => /browse/.test(n))).toEqual([
      'browse_library',
    ]);
    for (const name of ['browse_dirs', 'browse_folders', 'list_folders']) {
      const res = await client.callTool({ name, arguments: { path: '/' } });
      expect(res.isError, name).toBe(true);
      expect(text(res), name).toMatch(/not found/);
    }
    const res = await send(t, 'GET', '/fs/dirs?path=%2F', { headers: bearer(token) });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Folder browsing is a UI action');
  });

  it('a test-encode dry_run on a workflow that replaces and notifies writes nothing: dry_run with the measured size, library byte-identical, no fetch, no recycle row', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const id = t.deps.workflows.create(
        {
          name: 'Encode and notify',
          kind: 'workflow',
          graph: chain(
            'workflow',
            node('in', 'core:input-manual'),
            node('ev', 'core:encode-video', { codec: 'h264', encoder: 'libx264', skipIf: 'never' }),
            node('ro', 'core:replace-original'),
            node('n', 'core:notify-webhook', { url: 'https://hooks.example/t' } as JsonValue),
          ),
        },
        'u',
      ).id;
      const before = await readFile(file);
      const libraryBefore = (await readdir(join(base, 'lib'))).sort();
      const client = await mcpClient(t, token);
      const res = await client.callTool({
        name: 'dry_run',
        arguments: { path: file, workflowId: id, testEncode: true },
      });
      expect(res.isError, text(res)).toBeFalsy();
      const data = res.structuredContent as { jobIds: string[]; testEncode: boolean };
      expect(data.testEncode).toBe(true);
      const jobId = data.jobIds[0] as string;

      // The encode runs for real (here: a fake ffmpeg that writes 600 bytes).
      const deadline = Date.now() + 10_000;
      while (spawner.calls.length === 0) {
        if (Date.now() > deadline)
          throw new Error(`never spawned: ${findJob(t.deps.db, jobId)?.state}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      const call = spawner.calls[0] as { args: string[] };
      await writeFile(call.args.at(-1) as string, Buffer.alloc(600, 1));
      spawner.exit(0);
      const stateOf = () => findJob(t.deps.db, jobId)?.state as JobState;
      while (!isFinalState(stateOf())) {
        if (Date.now() > deadline) throw new Error(`never settled: ${stateOf()}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      const got = await client.callTool({ name: 'get_job', arguments: { id: jobId } });
      expect(got.structuredContent).toMatchObject({
        state: 'dry_run',
        dryRun: true,
        testEncode: true,
        afterBytes: 600,
        result: { outcome: 'dry_run', afterBytes: 600, replacedTo: null },
      });
      expect(text(got)).toMatch(/^Job \S+: dry_run, dry run, test encode — /);
      expect(await readFile(file)).toEqual(before);
      expect((await readdir(join(base, 'lib'))).sort()).toEqual(libraryBefore);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(listRecycled(t.deps.db)).toEqual([]);
      expect(spawner.calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('test outputs: no tool plays, downloads or deletes one, and the API refuses the all-scopes token', async () => {
    const client = await mcpClient(t, token);
    const { tools } = await client.listTools();
    expect(tools.filter((x) => /test_output/i.test(x.name))).toEqual([]);
    for (const x of tools) {
      expect(x.description ?? '', x.name).not.toMatch(
        /(play|download|delete)[^.]*test[ -]output|test[ -]output[^.]*(play|download|delete)/i,
      );
    }
    const get = await send(t, 'GET', '/jobs/any/test-output', { headers: bearer(token) });
    expect(get.status).toBe(403);
    expect(await get.text()).toContain('Test outputs are played in the UI');
    const del = await send(t, 'DELETE', '/jobs/any/test-output', { headers: bearer(token) });
    expect(del.status).toBe(403);
    expect(await del.text()).toContain('Test outputs are handled in the UI');
  });

  it('settings: no tool reads or changes settings or passwords, and the API refuses the all-scopes token', async () => {
    const client = await mcpClient(t, token);
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name);
    expect(names.filter((n) => /setting|config|theme|password|licen/i.test(n))).toEqual([]);
    expect([...names].sort()).toEqual([...EXPECTED_TOOLS].sort());
    const before = t.db.prepare('SELECT key, value FROM settings ORDER BY key').all();
    const patch = await send(t, 'PATCH', '/settings', {
      headers: bearer(token),
      body: { theme: 'light', pluginCallTimeoutMs: 1000 },
    });
    expect(patch.status).toBe(403);
    expect(await patch.text()).toContain('Settings are changed in the UI');
    const password = await send(t, 'POST', '/auth/password', {
      headers: bearer(token),
      body: { currentPassword: 'correct-horse-battery', newPassword: 'agent-chosen-password' },
    });
    expect(password.status).toBe(403);
    expect(await password.text()).toContain('Passwords are changed in the UI');
    expect(t.db.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual(before);
    // The old password still signs in.
    const again = await send(t, 'POST', '/auth/login', {
      body: { username: 'admin', password: 'correct-horse-battery' },
    });
    expect(again.status).toBe(200);
  });

  it('B4: an MCP save_workflow never changes which version runs for real', async () => {
    const client = await mcpClient(t, token);
    expect(t.deps.workflows.activate(plainId, 1, 'u').kind).toBe('ok');
    const saved = await client.callTool({
      name: 'save_workflow',
      arguments: { id: plainId, baseVersion: 1, graph: plain() },
    });
    expect(saved.structuredContent).toMatchObject({ version: 2, active: { version: 1 } });
    expect(t.deps.workflows.get(plainId)?.active?.version).toBe(1);
    const real = await t.deps.engine.queue.queue({
      path: file,
      workflowId: plainId,
      dryRun: false,
      force: true,
      priority: 0,
      createdBy: 'u',
    });
    if (real.kind !== 'queued') throw new Error(`expected queued, got ${real.kind}`);
    expect(real.run).toMatchObject({ workflowVersion: 1, dryRun: false });
  });

  it('duplicating an active workflow gives an inactive copy and leaves the source active', async () => {
    const client = await mcpClient(t, token);
    t.deps.workflows.save({ id: plainId, baseVersion: 1, graph: plain() }, 'u');
    expect(t.deps.workflows.activate(plainId, 2, 'u').kind).toBe('ok');
    const dup = await client.callTool({
      name: 'duplicate_workflow',
      arguments: { id: plainId, name: 'Copy' },
    });
    expect(dup.structuredContent).toMatchObject({ active: null });
    expect(t.deps.workflows.get(plainId)?.active?.version).toBe(2);
    const copyId = (dup.structuredContent as { id: string }).id;
    expect(t.deps.workflows.get(copyId)?.active).toBeNull();
  });

  it('no secret leaves /mcp: every read and write tool output, tools/list and the log are free of the webhook token', async () => {
    const client = await mcpClient(t, token);
    const outputs: unknown[] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      outputs.push(res);
      expect(JSON.stringify(res), name).not.toContain(SECRET);
      return res;
    };
    const redacted = async (id: string, version?: number) => {
      const got = await call('get_workflow', { id, ...(version ? { version } : {}) });
      expect(got.isError, text(got)).toBeFalsy();
      return (got.structuredContent as { graph: WorkflowGraph }).graph;
    };

    await call('list_workflows', {});
    const graph = await redacted(hookId);
    await redacted(hookId, 1);
    await call('list_workflow_versions', { id: hookId });
    await call('validate_workflow', { graph, workflowId: hookId });
    const saved = await call('save_workflow', { id: hookId, baseVersion: 1, graph });
    expect(saved.isError, text(saved)).toBeFalsy();
    const dup = await call('duplicate_workflow', { id: hookId, name: 'Hook copy' });
    expect(dup.isError, text(dup)).toBeFalsy();
    const copyId = (dup.structuredContent as { id: string }).id;
    const copyGraph = JSON.stringify(await redacted(copyId));
    expect(copyGraph).not.toContain('media.base');
    expect(copyGraph).not.toContain('n.url');
    const stored = JSON.stringify(t.deps.workflows.get(copyId)?.graph);
    expect(stored).toContain('"url":""');
    expect(stored).not.toContain('hooks.example');
    expect(stored).not.toContain(SECRET);
    const withUrl = await call('create_workflow', {
      name: 'Real URL',
      kind: 'workflow',
      graph: chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('ro', 'core:replace-original'),
        node('n', 'core:notify-webhook', { url: `https://h/p?k=${SECRET}` } as JsonValue),
      ),
    });
    expect(withUrl.isError, text(withUrl)).toBeFalsy();
    expect(withUrl.structuredContent).not.toHaveProperty('graph');
    await call('list_nodes', {});
    await call('list_nodes', { type: 'core:notify-webhook' });
    const dry = await call('dry_run', { path: file, workflowId: hookId, force: true });
    expect(dry.isError, text(dry)).toBeFalsy();
    const { runId, jobIds } = dry.structuredContent as { runId: string; jobIds: string[] };
    const jobId = jobIds[0] as string;
    // Let the dry run plan and finish so its decisions and log exist.
    for (let i = 0; i < 100; i++) {
      const j = await client.callTool({ name: 'get_job', arguments: { id: jobId } });
      const state = (j.structuredContent as { state?: string }).state;
      if (state && isFinalState(state as JobState)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await call('get_job', { id: jobId });
    await call('get_job_log', { id: jobId });
    await call('list_jobs', {});
    await call('get_run', { id: runId });
    await call('list_runs', {});
    await call('queue_status', {});

    expect(JSON.stringify(await client.listTools())).not.toContain('hook-secret');
    expect(outputs.length).toBeGreaterThan(15);
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join('\n')).not.toContain(SECRET);
    // The API token never appears in a log line or any tool output.
    for (const needle of [token, 'tcd_']) {
      expect(logLines.join('\n')).not.toContain(needle);
      expect(JSON.stringify(outputs)).not.toContain(needle);
      expect(JSON.stringify(await client.listTools())).not.toContain(needle);
    }

    // The stored graph still holds the secret.
    expect(JSON.stringify(t.deps.workflows.get(hookId)?.graph)).toContain(SECRET);
  });

  it('a hidden tool never reaches its handler: with a read token no write or manage tool runs', async () => {
    const { token: readToken } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const client = await mcpClient(t, readToken);
    const hidden = ALL_TOOLS.filter((d) => !d.scopes.includes('read'));
    expect(hidden.map((d) => d.name).sort()).toEqual(
      [
        'pause_queue',
        'resume_queue',
        'pause_job',
        'resume_job',
        'cancel_job',
        'cancel_all_jobs',
        'create_workflow',
        'save_workflow',
        'duplicate_workflow',
        'rename_workflow',
        'delete_workflow',
        'dry_run',
      ].sort(),
    );
    const spies = hidden.map((d) => vi.spyOn(d, 'run'));
    for (const d of hidden) {
      const res = await client.callTool({ name: d.name, arguments: { id: plainId } });
      expect(res.isError, d.name).toBe(true);
      expect(text(res), d.name).toMatch(/not found/);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('an unexpected error (corrupt stored graph) is an INTERNAL tool result, logged once, and the JSON-RPC response is well-formed', async () => {
    const client = await mcpClient(t, token);
    vi.spyOn(t.deps.workflows, 'get').mockImplementation(() => {
      throw new CorruptGraphError('w', 1, `bad json ${SECRET}`);
    });
    const res = await client.callTool({ name: 'get_workflow', arguments: { id: plainId } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^INTERNAL: /);
    for (const needle of [SECRET, 'bad json', token]) {
      expect(JSON.stringify(res)).not.toContain(needle);
      expect(logLines.join('\n')).not.toContain(needle);
    }
    const failed = logLines.filter((l) => l.includes('mcp tool failed'));
    expect(failed).toHaveLength(1);
    const calls = logLines.filter((l) => l.includes('mcp tool call'));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0] as string)).toMatchObject({ ok: false, code: 'INTERNAL' });
    // The connection is still good afterwards.
    const after = await client.callTool({ name: 'queue_status', arguments: {} });
    expect(after.isError).toBeFalsy();
  });

  it('silent overwrite is impossible: a save with an outdated baseVersion never writes', async () => {
    const a = await mcpClient(t, token);
    const b = await mcpClient(t, token);
    t.deps.workflows.save({ id: plainId, baseVersion: 1, graph: plain() }, 'u');
    const got = await a.callTool({ name: 'get_workflow', arguments: { id: plainId } });
    const aVersion = (got.structuredContent as { version: number }).version;
    expect(aVersion).toBe(2);

    const bGraph = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('ro', 'core:replace-original'),
      node('t', 'core:notify-webhook', { url: '' } as JsonValue),
    );
    const bSaved = await b.callTool({
      name: 'save_workflow',
      arguments: { id: plainId, baseVersion: 2, graph: bGraph },
    });
    expect(bSaved.structuredContent).toMatchObject({ version: 3 });

    const stale = await a.callTool({
      name: 'save_workflow',
      arguments: { id: plainId, baseVersion: 2, graph: plain() },
    });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toBeUndefined();
    expect(text(stale)).toContain('VERSION_CONFLICT');
    expect(text(stale)).toContain('save again with baseVersion 3');
    const versions = await b.callTool({
      name: 'list_workflow_versions',
      arguments: { id: plainId },
    });
    expect((versions.structuredContent as { versions: unknown[] }).versions).toHaveLength(3);
    expect(t.deps.workflows.get(plainId)?.graph).toEqual(bGraph);
  });
});
