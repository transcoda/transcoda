import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import type { JsonValue, WorkflowGraph } from '@transcoda/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import { tempDir } from '../../engine/fixtures.ts';
import { type FsOps, nodeFsOps } from '../../engine/fs-ops.ts';
import { FakeSpawner } from '../../engine/process.ts';
import { createTestApp, type TestApp } from '../../test-app.ts';
import { asSession, createToken, login, type Session, send } from '../../test-http.ts';
import { bumpV1, chain, childGraph, node, testRegistry } from '../../workflows/test-helpers.ts';
import { mcpClient } from '../test-client.ts';
import { workflowReadTools } from './workflows-read.ts';
import { WEBHOOK_HINT, workflowWriteTools } from './workflows-write.ts';

const SECRET = 'hook-secret-7f3a';

const text = (res: unknown) =>
  ((res as { content?: { text: string }[] }).content ?? [])[0]?.text ?? '';

const plain = (): WorkflowGraph =>
  chain('workflow', node('in', 'core:input-manual'), node('ro', 'core:replace-original'));

const hookGraph = (): WorkflowGraph =>
  chain(
    'workflow',
    node('in', 'core:input-manual'),
    node('n', 'core:notify-webhook', {
      url: `https://hooks.example/t?token=${SECRET}`,
    } as JsonValue),
    node('ro', 'core:replace-original'),
  );

async function setup(scopes: ('read' | 'workflows:write')[] = ['read', 'workflows:write']) {
  const t = createTestApp({
    nodes: testRegistry(bumpV1()).list(),
    mcpTools: [...workflowReadTools, ...workflowWriteTools],
  });
  const s = await login(t);
  const { token } = await createToken(t, s, { name: 'w', scopes });
  return { t, s, client: await mcpClient(t, token) };
}

async function versionsOf(t: TestApp, s: Session, id: string) {
  const res = await send(t, 'GET', `/workflows/${id}/versions`, { headers: asSession(s, false) });
  return ((await res.json()) as { versions: { version: number; note: string }[] }).versions;
}

describe('workflow write tools', () => {
  it('create_workflow with a graph stores v1 with note "via MCP: <note>"; the version note is capped at 120', async () => {
    const { t, s, client } = await setup();
    const note = 'x'.repeat(111);
    const res = await client.callTool({
      name: 'create_workflow',
      arguments: { name: 'Made', kind: 'workflow', graph: plain(), note },
    });
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as { id: string; version: number; active: unknown };
    expect(data).toMatchObject({ name: 'Made', kind: 'workflow', version: 1, active: null });
    expect(text(res)).toContain(`Created workflow "Made" (${data.id}) v1, not active.`);
    expect(text(res)).toContain('Next: save_workflow with baseVersion 1');
    const [v1] = await versionsOf(t, s, data.id);
    expect(v1?.note).toHaveLength(120);
    expect(v1?.note.startsWith('via MCP: ')).toBe(true);

    const tooLong = await client.callTool({
      name: 'create_workflow',
      arguments: { name: 'Nope', kind: 'workflow', note: 'x'.repeat(112) },
    });
    expect(tooLong.isError).toBe(true);
    expect(text(tooLong)).toMatch(/Input validation error/);
  });

  it('create_workflow without a note says "via MCP"', async () => {
    const { t, s, client } = await setup();
    const res = await client.callTool({
      name: 'create_workflow',
      arguments: { name: 'Empty', kind: 'subworkflow' },
    });
    const { id } = res.structuredContent as { id: string };
    expect((await versionsOf(t, s, id))[0]?.note).toBe('via MCP');
  });

  it('save_workflow: a stale baseVersion is VERSION_CONFLICT with currentVersion and a hint; the right one saves v3 with note "via MCP"', async () => {
    const { t, s, client } = await setup();
    const created = await client.callTool({
      name: 'create_workflow',
      arguments: { name: 'W', kind: 'workflow' },
    });
    const { id } = created.structuredContent as { id: string };
    const v2 = await client.callTool({
      name: 'save_workflow',
      arguments: { id, baseVersion: 1, graph: plain() },
    });
    expect(v2.structuredContent).toMatchObject({ version: 2 });

    const stale = await client.callTool({
      name: 'save_workflow',
      arguments: { id, baseVersion: 1, graph: plain() },
    });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toBeUndefined();
    expect(text(stale)).toMatch(/^VERSION_CONFLICT: /);
    expect(text(stale)).toContain('save again with baseVersion 2');

    const graph = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('b', 'test:bump'),
      node('ro', 'core:replace-original'),
    );
    const ok = await client.callTool({
      name: 'save_workflow',
      arguments: { id, baseVersion: 2, graph },
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ version: 3, active: null });
    expect(text(ok)).toContain(`Saved ${id} as v3`);
    expect(text(ok)).toContain('Not active; real runs stay off');
    expect((await versionsOf(t, s, id))[0]).toMatchObject({ version: 3, note: 'via MCP' });
    expect(t.deps.workflows.get(id)?.graph).toEqual(graph);
  });

  it('save_workflow with a graph of the other kind → KIND_MISMATCH result; a redacted URL sent back unchanged keeps the stored URL; one that matches nothing → HIDDEN_URL_UNKNOWN naming the node', async () => {
    const { t, client } = await setup();
    const wf = await client.callTool({
      name: 'create_workflow',
      arguments: { name: 'Hooked', kind: 'workflow', graph: hookGraph() },
    });
    const { id } = wf.structuredContent as { id: string };

    const sub = chain('subworkflow', node('kl', 'core:keep-languages', { languages: ['en'] }));
    const mismatch = await client.callTool({
      name: 'save_workflow',
      arguments: { id, baseVersion: 1, graph: sub },
    });
    expect(mismatch.isError).toBe(true);
    expect(text(mismatch)).toMatch(/^KIND_MISMATCH: /);
    const badCreate = await client.callTool({
      name: 'create_workflow',
      arguments: { name: 'Bad', kind: 'workflow', graph: sub },
    });
    expect(text(badCreate)).toMatch(/^KIND_MISMATCH: /);

    const got = await client.callTool({ name: 'get_workflow', arguments: { id } });
    const redacted = (got.structuredContent as { graph: WorkflowGraph }).graph;
    expect(JSON.stringify(got)).not.toContain(SECRET);
    const resave = await client.callTool({
      name: 'save_workflow',
      arguments: { id, baseVersion: 1, graph: redacted },
    });
    expect(resave.isError).toBeFalsy();
    expect(JSON.stringify(t.deps.workflows.get(id)?.graph)).toContain(SECRET);

    const other: WorkflowGraph = {
      ...redacted,
      nodes: [
        ...redacted.nodes,
        node('n2', 'core:notify-webhook', { url: 'https://other/…' } as JsonValue),
      ],
    };
    const unknown = await client.callTool({
      name: 'save_workflow',
      arguments: { id, baseVersion: 2, graph: other },
    });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/^HIDDEN_URL_UNKNOWN: /);
    expect(text(unknown)).toContain('Enter a full webhook URL in node(s) n2');
    expect(JSON.stringify(unknown)).not.toContain(SECRET);
  });

  it('duplicate_workflow copies under the new name without the webhook URL and says which nodes need one; rename and delete work; deleting a used sub-workflow is IN_USE with its users', async () => {
    const { t, client } = await setup();
    const wf = await client.callTool({
      name: 'create_workflow',
      arguments: { name: 'Hooked', kind: 'workflow', graph: hookGraph() },
    });
    const { id } = wf.structuredContent as { id: string };
    const bumped = await client.callTool({
      name: 'save_workflow',
      arguments: { id, baseVersion: 1, graph: plain() },
    });
    expect(bumped.isError).toBeFalsy();
    // Back to the hook on v3 so the current version is 3 and holds the URL.
    t.deps.workflows.save({ id, baseVersion: 2, graph: hookGraph() }, 'u');

    const dup = await client.callTool({
      name: 'duplicate_workflow',
      arguments: { id, name: 'Copy' },
    });
    expect(dup.isError).toBeFalsy();
    expect(dup.structuredContent).toMatchObject({
      name: 'Copy',
      sourceId: id,
      sourceVersion: 3,
      droppedWebhookUrls: ['n'],
      active: null,
      version: 1,
    });
    expect(text(dup)).toContain('set a new url in: n');
    const copyId = (dup.structuredContent as { id: string }).id;
    const copy = await client.callTool({ name: 'get_workflow', arguments: { id: copyId } });
    const n = (copy.structuredContent as { graph: WorkflowGraph }).graph.nodes.find(
      (x) => x.id === 'n',
    );
    // The redacted view shows an empty URL as the "an invalid URL" placeholder; the stored one is ''.
    expect(n?.settings).toMatchObject({ url: 'an invalid URL' });
    expect(JSON.stringify(t.deps.workflows.get(copyId)?.graph)).toContain('"url":""');
    expect(JSON.stringify([dup, copy])).not.toContain(SECRET);

    const renamed = await client.callTool({
      name: 'rename_workflow',
      arguments: { id: copyId, name: 'Renamed' },
    });
    expect(renamed.structuredContent).toMatchObject({ id: copyId, name: 'Renamed' });
    expect(text(renamed)).toBe(`Renamed ${copyId} to "Renamed".`);

    const sub = await client.callTool({
      name: 'create_workflow',
      arguments: { name: 'Sub', kind: 'subworkflow', graph: childGraph() },
    });
    const subId = (sub.structuredContent as { id: string }).id;
    const main = await client.callTool({
      name: 'create_workflow',
      arguments: {
        name: 'Main',
        kind: 'workflow',
        graph: chain(
          'workflow',
          node('in', 'core:input-manual'),
          node('run', 'core:run-subworkflow', {
            subworkflowId: subId,
            version: 1,
            overrides: {},
          } as JsonValue),
          node('ro', 'core:replace-original'),
        ),
      },
    });
    const mainId = (main.structuredContent as { id: string }).id;
    const blocked = await client.callTool({ name: 'delete_workflow', arguments: { id: subId } });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toMatch(/^IN_USE: /);
    expect(text(blocked)).toContain('Main');
    const gone = await client.callTool({ name: 'delete_workflow', arguments: { id: mainId } });
    expect(gone.structuredContent).toEqual({ ok: true, id: mainId });
    const goneSub = await client.callTool({ name: 'delete_workflow', arguments: { id: subId } });
    expect(goneSub.isError).toBeFalsy();
  });

  it('a workflows:write-only token (no read) can duplicate, rename and delete', async () => {
    const { t, client } = await setup(['workflows:write']);
    const { id } = t.deps.workflows.create({ name: 'Src', kind: 'workflow', graph: plain() }, 'u');
    const dup = await client.callTool({ name: 'duplicate_workflow', arguments: { id, name: 'C' } });
    expect(dup.isError).toBeFalsy();
    const copyId = (dup.structuredContent as { id: string }).id;
    expect(
      (await client.callTool({ name: 'rename_workflow', arguments: { id: copyId, name: 'D' } }))
        .isError,
    ).toBeFalsy();
    expect(
      (await client.callTool({ name: 'delete_workflow', arguments: { id: copyId } })).isError,
    ).toBeFalsy();
  });

  it('write tools are hidden from a read token; calling save_workflow with it resolves to isError "Tool save_workflow not found" (no structuredContent)', async () => {
    const { client } = await setup(['read']);
    const names = (await client.listTools()).tools.map((x) => x.name);
    for (const n of [
      'create_workflow',
      'save_workflow',
      'duplicate_workflow',
      'rename_workflow',
      'delete_workflow',
    ]) {
      expect(names).not.toContain(n);
    }
    const res = await client.callTool({
      name: 'save_workflow',
      arguments: { id: 'x', baseVersion: 1, graph: plain() },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    expect(text(res)).toContain('Tool save_workflow not found');
  });

  it('tool descriptions of create, save and duplicate carry the webhook hint', async () => {
    const { client } = await setup();
    const tools = (await client.listTools()).tools;
    for (const n of ['create_workflow', 'save_workflow', 'duplicate_workflow']) {
      expect(tools.find((x) => x.name === n)?.description).toContain(WEBHOOK_HINT);
    }
  });
});

describe('B4: an MCP save never changes which version runs for real', () => {
  let base: string | undefined;
  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true });
    base = undefined;
  });

  const caps: Capabilities = {
    available: true,
    path: '/usr/bin/ffmpeg',
    version: '9.0.2',
    encoders: ['aac', 'libx264', 'libx265'],
    hwaccels: [],
    filters: ['pan'],
  };
  const exec: Exec = async () => ({ stdout: '', stderr: '' });
  const fsOps: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) };

  it('activate v1, save through MCP → v2: v1 stays active and a real queue pins v1; with nothing active a save keeps active null and a real queue is a dry run', async () => {
    base = await tempDir('mcp-b4-');
    const root = join(base, 'lib');
    await mkdir(root, { recursive: true });
    const file = join(root, 'a.mkv');
    await writeFile(file, Buffer.alloc(1000, 7));
    const t = createTestApp({
      config: {
        configDir: join(base, 'config'),
        transcodeDir: join(base, 'transcode'),
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
      },
      capabilities: caps,
      spawner: new FakeSpawner(),
      fsOps,
      exec,
      heartbeatMs: 10,
      mcpTools: workflowWriteTools,
    });
    await t.deps.engine.start();
    try {
      const s = await login(t);
      const lib = await send(t, 'POST', '/libraries', {
        body: { name: 'TV', path: root },
        headers: asSession(s, true),
      });
      expect(lib.status).toBe(200);
      const { token } = await createToken(t, s, { name: 'w', scopes: ['workflows:write'] });
      const client = await mcpClient(t, token);
      const { id } = t.deps.workflows.create(
        { name: 'Main', kind: 'workflow', graph: plain() },
        'u',
      );
      const realQueue = () =>
        t.deps.engine.queue.queue({
          path: file,
          workflowId: id,
          dryRun: false,
          force: true,
          priority: 0,
          createdBy: 'u',
        });
      const snapshot = () => t.deps.workflows.list().map((w) => [w.id, w.active]);

      // Nothing active: a save keeps it that way; a real queue is a dry run.
      const first = await client.callTool({
        name: 'save_workflow',
        arguments: { id, baseVersion: 1, graph: plain() },
      });
      expect(first.structuredContent).toMatchObject({ version: 2, active: null });
      const none = await realQueue();
      if (none.kind !== 'queued') throw new Error(`expected queued, got ${none.kind}`);
      expect(none.run).toMatchObject({ dryRun: true, note: 'no active version' });

      // v2 active; an MCP save makes v3 and v2 keeps running.
      expect(t.deps.workflows.activate(id, 2, 'u').kind).toBe('ok');
      const before = snapshot();
      const saved = await client.callTool({
        name: 'save_workflow',
        arguments: { id, baseVersion: 2, graph: plain() },
      });
      expect(saved.structuredContent).toMatchObject({ version: 3, active: { version: 2 } });
      expect(text(saved)).toContain('v2 stays active');
      expect(snapshot()).toEqual(before);
      expect(t.deps.workflows.get(id)?.active?.version).toBe(2);
      const real = await realQueue();
      if (real.kind !== 'queued') throw new Error(`expected queued, got ${real.kind}`);
      expect(real.run).toMatchObject({ workflowVersion: 2, dryRun: false });
    } finally {
      await t.deps.engine.stop();
    }
  }, 30_000);
});
