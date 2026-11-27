// Finish steps after the write (pipeline-steps.ts): plugin finish steps, job hooks, a real
// plugin host.
import { readFileSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineEventSchema } from '@transcoda/contract';
import {
  defineNode,
  type FinishRunContext,
  type FinishRunResult,
  type HookJob,
} from '@transcoda/sdk';
import type { JsonValue } from '@transcoda/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { asSession, createToken, login, send } from '../../app/testing/http.ts';
import { findJobResult, listTrace } from '../../db/repos/jobs/jobs.ts';
import { mcpClient } from '../../mcp/test-client.ts';
import { filePort } from '../../nodes/core/common.ts';
import type { RegisteredNode } from '../../nodes/registry.ts';
import { RemoteHookError, remoteNodeDefinition } from '../../nodes/remote.ts';
import { type HookName, PluginHooksRunner } from '../../plugins/runtime/hooks.ts';
import { fixturePluginPath } from '../../plugins/testing/build.ts';
import { edge, mainGraph, node } from '../../workflows/test-helpers.ts';
import { PLUGIN_RETRY_MS } from './steps.ts';
import {
  base,
  encodeAnd,
  fake,
  file,
  gated,
  moveCopy,
  published,
  queue,
  replaceNode,
  root,
  row,
  runOnce,
  settled,
  setup,
  spawner,
  states,
  t,
  toH264,
  until,
  workflow,
} from './testing.ts';

describe('pipeline: plugin finish steps and hooks', () => {
  const SOURCE = { kind: 'plugin', name: 'example', version: '1.0.0' } as const;
  /** What the plugin's `run` does; set per test. */
  let runImpl: (ctx: FinishRunContext) => Promise<FinishRunResult>;
  let runCalls: FinishRunContext[];
  /** A reason the plugin is down (its entry's `unavailable`). */
  let pluginDown: string | null;
  /** The build hook of example:act, per test. */
  let actImpl: () => Promise<void>;
  let order: string[];
  let hookCalls: { hook: string; job: HookJob; resultProblems: string[] | null }[];

  const note = defineNode({
    type: 'example:note',
    version: 1,
    kind: 'finish',
    finishPhase: 'notify',
    title: 'Note',
    description: 'A plugin finish node.',
    icon: 'bell',
    inputs: [filePort],
    outputs: [],
    settings: z.object({ required: z.boolean().default(false) }),
    async finish(_ctx, settings) {
      return {
        actions: [{ kind: 'plugin', description: 'tell room b', required: settings.required }],
        reason: 'queued',
      };
    },
    async run(ctx) {
      order.push('run');
      runCalls.push(ctx);
      return runImpl(ctx);
    },
  });
  const act = defineNode({
    type: 'example:act',
    version: 1,
    kind: 'action',
    title: 'Act',
    description: 'A plugin action node.',
    icon: 'bell',
    inputs: [filePort],
    outputs: [filePort],
    settings: z.object({}),
    async build(ctx) {
      await actImpl();
      return { model: ctx.model, reason: 'acted' };
    },
  });
  /** Plugin finish nodes of the earlier phases (no outputs, like the real ones); `run` logs. */
  let libImpl: () => Promise<FinishRunResult>;
  const phased = (type: string, finishPhase: 'library-manager' | 'media-server', name: string) =>
    defineNode({
      type,
      version: 1,
      kind: 'finish',
      finishPhase,
      title: name,
      description: 'A plugin finish node.',
      icon: 'bell',
      inputs: [filePort],
      outputs: [],
      settings: z.object({}),
      async finish() {
        return { actions: [{ kind: 'plugin', description: name, required: true }], reason: name };
      },
      async run(ctx) {
        order.push(`${name}:${ctx.outcome}:${ctx.problemsSoFar.join(',')}`);
        return name === 'lib' ? libImpl() : { ok: true, message: name };
      },
    });
  const lib = phased('example:lib', 'library-manager', 'lib');
  const media = phased('example:media', 'media-server', 'media');
  const entries = (): RegisteredNode[] => [
    { def: note, source: SOURCE, unavailable: () => pluginDown },
    { def: act, source: SOURCE, unavailable: () => pluginDown },
    { def: lib, source: SOURCE, unavailable: () => pluginDown },
    { def: media, source: SOURCE, unavailable: () => pluginDown },
  ];

  function hooksRunner(declared: HookName[] = ['onJobDone', 'onJobFailed', 'afterReplace']) {
    const runner = new PluginHooksRunner({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => new Date(),
      timeoutMs: 1000,
    });
    runner.attachTarget({
      running: () => ['example'],
      declaredHooks: () => declared,
      hook: async (_name, hook, job) => {
        order.push(hook);
        hookCalls.push({
          hook,
          job,
          resultProblems: findJobResult(t.db, job.id)?.problems ?? null,
        });
        return { ok: true };
      },
    });
    return runner;
  }

  /** The 10 s wait before a plugin step's retry takes 5 ms; returns every delay asked for. */
  function fastPluginRetry(): number[] {
    const real = globalThis.setTimeout;
    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms = 0) => {
      delays.push(ms);
      return real(fn, ms === PLUGIN_RETRY_MS ? 5 : ms);
    }) as typeof setTimeout);
    return delays;
  }

  const withNote = (settings = {}, ...before: ReturnType<typeof node>[]) =>
    encodeAnd(...before, replaceNode(), node('pn', 'example:note', settings));

  beforeEach(async () => {
    runCalls = [];
    order = [];
    hookCalls = [];
    pluginDown = null;
    runImpl = async () => ({ ok: true, message: 'noted' });
    actImpl = async () => {};
    libImpl = async () => ({ ok: true, message: 'lib' });
    await t.deps.engine.stop();
    await setup({ extra: entries(), hooks: hooksRunner() });
  });

  it('hands the job page URL to a plugin step and to the hooks when TRANSCODA_PUBLIC_URL is set', async () => {
    await t.deps.engine.stop();
    await setup({ extra: entries(), hooks: hooksRunner(), publicUrl: 'https://t.example.net' });
    const id = await queue(file(), withNote());
    await runOnce(id);
    await until('onJobDone', () => hookCalls.some((c) => c.hook === 'onJobDone'));
    const url = `https://t.example.net/jobs/${id}`;
    expect(runCalls[0]).toMatchObject({ jobUrl: url });
    expect(hookCalls.map((h) => h.job.jobUrl)).toEqual([url, url]);
    const wfId = hookCalls[0]?.job.workflowId ?? '';
    const name = t.deps.workflows.get(wfId)?.name;
    expect(name).toBeTruthy();
    expect(runCalls[0]).toMatchObject({ workflowName: name });
    expect(hookCalls.map((h) => h.job.workflowName)).toEqual([name, name]);
  });

  it('else: a plugin finish step behind a failing gate runs with the kept context; pass-only steps do not', async () => {
    const wf = workflow(
      gated(
        50,
        [replaceNode(), node('pp', 'example:note', { required: false })],
        [node('pe', 'example:note', { required: false })],
      ),
    );
    const id = await queue(file(), wf);
    const job = await runOnce(id, 900);
    expect(job).toMatchObject({ state: 'kept_original', reason: 'saved only 10.0%, below 50%' });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toMatchObject({
      originalPath: file(),
      newPath: file(),
      replacedTo: null,
      beforeBytes: 1000,
      afterBytes: 900,
      outcome: 'kept',
      containerChanged: false,
      problemsSoFar: [],
      gate: { savedPercent: 10, minSavingPercent: 50 },
    });
    expect((await stat(file())).size).toBe(1000);
  });

  it('else: a failing plugin step is a warning (required or not) on the kept_original job', async () => {
    runImpl = async () => ({ ok: false, message: 'room is closed' });
    const wf = workflow(
      gated(50, [replaceNode()], [node('pe', 'example:note', { required: true })]),
    );
    const id = await queue(file(), wf);
    const job = await runOnce(id, 900);
    expect(job.state).toBe('kept_original');
    expect(findJobResult(t.db, id)?.warnings).toEqual(['room is closed']);
    // Nothing was written: on its node it is a warning too.
    expect(findJobResult(t.db, id)?.nodeProblems).toEqual([
      { workflowPath: [], nodeId: 'pe', severity: 'warning', message: 'room is closed' },
    ]);
  });

  it('else: a notify step behind a failing gate is the current node while it sends, not the gate', async () => {
    let id = '';
    /** The job's current node as last published when the webhook is sent. */
    let atSend: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const last = published.filter((e) => e.type === 'job.changed' && e.jobId === id).at(-1);
        atSend = last?.type === 'job.changed' ? last.currentNode?.nodeId : undefined;
        return new Response(null, { status: 204 });
      }),
    );
    const wf = workflow(
      gated(
        50,
        [replaceNode()],
        [
          node('ne', 'core:notify-webhook', {
            url: 'https://hooks.example.com/kept',
            method: 'POST',
          }),
        ],
      ),
    );
    id = await queue(file(), wf);
    expect(await runOnce(id, 900)).toMatchObject({ state: 'kept_original' });
    expect(atSend).toBe('ne');
  });

  it('pass: the context a plugin step gets has no gate', async () => {
    const wf = workflow(
      gated(50, [replaceNode(), node('pp', 'example:note', { required: false })], []),
    );
    const id = await queue(file(), wf);
    await runOnce(id, 400);
    expect(runCalls[0]?.outcome).toBe('replaced');
    expect(runCalls[0]?.gate).toBeNull();
  });

  describe('several finish steps on one output', () => {
    /** in → encode → `head`; `head`'s output feeds every node of `fan` (in the order given). */
    const fanned = (head: ReturnType<typeof node>, fan: ReturnType<typeof node>[]) =>
      workflow(
        mainGraph(
          [node('in', 'core:input-manual'), toH264(), head, ...fan],
          [edge('in', 'ev'), edge('ev', head.id), ...fan.map((n) => edge(head.id, n.id))],
        ),
      );

    it('three plugin steps off Replace original run after the write in phase order, as if chained', async () => {
      libImpl = async () => ({ ok: false, message: 'library said no' });
      // Wired notify, media server, library manager: the reverse of the phase order.
      const wf = fanned(replaceNode(), [
        node('pn', 'example:note', { required: false }),
        node('pm', 'example:media'),
        node('pl', 'example:lib'),
      ]);
      const id = await queue(file(), wf);
      const job = await runOnce(id);
      expect(job).toMatchObject({
        state: 'done',
        reason: 'finished with a problem: library said no',
      });
      await until('onJobDone', () => order.includes('onJobDone'));
      // The write first, then library manager → media server → notify; a later step sees the
      // earlier one's problem, as on a chain.
      expect(order).toEqual([
        'afterReplace',
        'lib:replaced:',
        'media:replaced:library said no',
        'run',
        'onJobDone',
      ]);
      expect(runCalls[0]?.problemsSoFar).toEqual(['library said no']);
      expect((await stat(file())).size).toBe(600);
      expect(t.deps.engine.jobDetail(id)?.path.map((s) => s.nodeId)).toEqual([
        'in',
        'ev',
        'render-1',
        'ro',
        'pl',
        'pm',
        'pn',
      ]);
    });

    it('two steps on the size gate\u2019s No run in phase order on a kept original; the pass steps do not', async () => {
      const wf = workflow(
        mainGraph(
          [
            node('in', 'core:input-manual'),
            toH264(),
            node('sg', 'core:size-gate', { minSavingPercent: 50 }),
            replaceNode(),
            node('pp', 'example:note', { required: false }),
            node('en', 'example:note', { required: false }),
            node('em', 'example:media'),
          ],
          [
            edge('in', 'ev'),
            edge('ev', 'sg'),
            edge('sg', 'ro', { from: 'pass' }),
            edge('ro', 'pp'),
            edge('sg', 'en', { from: 'else' }),
            edge('sg', 'em', { from: 'else' }),
          ],
        ),
      );
      const id = await queue(file(), wf);
      const job = await runOnce(id, 900);
      expect(job).toMatchObject({ state: 'kept_original', reason: 'saved only 10.0%, below 50%' });
      expect(order.filter((o) => o !== 'onJobDone')).toEqual(['media:kept:', 'run']);
      expect(runCalls).toHaveLength(1);
      expect(runCalls[0]).toMatchObject({ outcome: 'kept', gate: { minSavingPercent: 50 } });
      expect((await stat(file())).size).toBe(1000);
      expect(t.deps.engine.jobDetail(id)?.path.map((s) => `${s.nodeId}:${s.port}`)).toEqual([
        'in:file',
        'ev:file',
        'render-1:done',
        'sg:else',
        'em:null',
        'en:null',
      ]);
    });
  });

  it('runs a plugin finish step after the write with the run context and ends done', async () => {
    const id = await queue(file(), withNote());
    const job = await runOnce(id);
    expect(job).toMatchObject({ state: 'done', reason: null });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toMatchObject({
      originalPath: file(),
      newPath: file(),
      replacedTo: 'recycle',
      beforeBytes: 1000,
      afterBytes: 600,
      outcome: 'replaced',
      containerChanged: false,
      problemsSoFar: [],
      jobUrl: null,
      workflowName: expect.any(String),
      plugin: { dryRun: false, job: { id, attempt: 1 } },
      data: {},
    });
    // The write came first.
    expect((await stat(file())).size).toBe(600);
    expect(findJobResult(t.db, id)).toMatchObject({ problems: [], warnings: [] });
  });

  it("records a plugin step's own answer on the trace after its planned entry (C2, #37)", async () => {
    runImpl = async () => ({ ok: true, message: 'Radarr lists /media/movies/a.mkv' });
    const id = await queue(file(), withNote());
    expect(await runOnce(id)).toMatchObject({ state: 'done' });
    const pn = listTrace(t.db, id).filter((e) => e.nodeId === 'pn');
    expect(pn.map((e) => [e.phase, e.source, e.reason])).toEqual([
      ['finish', 'plugin', 'queued'],
      ['finish', 'plugin', 'Radarr lists /media/movies/a.mkv'],
    ]);
    expect(pn[1]).toMatchObject({ attempt: 1, workflowPath: [], port: null, findings: {} });
    const traced = published.filter((e) => e.type === 'job.trace' && e.jobId === id);
    expect(traced.at(-1)).toMatchObject({ entry: { nodeId: 'pn', reason: pn[1]?.reason } });
  });

  it("caps a plugin step's answer on the trace at 2000 characters", async () => {
    runImpl = async () => ({ ok: false, message: 'y'.repeat(5000) });
    const id = await queue(file(), withNote());
    await runOnce(id);
    const reason = listTrace(t.db, id).at(-1)?.reason ?? '';
    expect(reason).toHaveLength(2000);
    expect(reason).toMatch(/^failed: y+…$/);
  });

  it("records a failed plugin step's answer on the trace as failed: <message>", async () => {
    runImpl = async () => ({ ok: false, message: 'room b did not answer' });
    const id = await queue(file(), withNote());
    await runOnce(id);
    expect(listTrace(t.db, id).at(-1)).toMatchObject({
      nodeId: 'pn',
      phase: 'finish',
      source: 'plugin',
      reason: 'failed: room b did not answer',
    });
  });

  it.each([
    ['no message', { ok: true }],
    ['a non-string message', { ok: true, message: { secret: 'x' } }],
    ['an oversize message', { ok: true, message: 'x'.repeat(50_000) }],
  ])(
    'a plugin run answer with %s is a failed step; the job API, get_job and the event still work',
    async (_name, answer) => {
      const remote = remoteNodeDefinition(
        {
          type: 'example:rbad',
          version: 1,
          kind: 'finish',
          title: 'Remote bad',
          description: 'A plugin finish node with a broken run answer.',
          icon: 'bell',
          inputs: [filePort],
          outputs: [],
          settingsSchema: { type: 'object', properties: {} },
          onNodeSettings: [],
          requires: {},
          migrations: [],
          finishPhase: 'notify',
          hooks: ['finish', 'run'],
        },
        SOURCE,
        {
          async call(hook) {
            return hook === 'finish'
              ? {
                  ok: true,
                  result: {
                    actions: [{ kind: 'plugin', description: 'tell', required: false }],
                    reason: 'queued',
                  },
                }
              : { ok: true, result: answer as JsonValue };
          },
        },
        { callTimeoutMs: 1000, finishRunTimeoutMs: 1000 },
      );
      await t.deps.engine.stop();
      await setup({ extra: [...entries(), { def: remote, source: SOURCE }], hooks: hooksRunner() });
      const id = await queue(file(), encodeAnd(replaceNode(), node('pb', 'example:rbad', {})));
      expect(await runOnce(id)).toMatchObject({ state: 'done' });
      const last = listTrace(t.db, id).at(-1);
      expect(last).toMatchObject({ nodeId: 'pb', source: 'plugin' });
      expect(last?.reason).toMatch(/^failed: plugin example sent an invalid run answer/);
      expect(last?.reason.length).toBeLessThanOrEqual(2000);
      expect(findJobResult(t.db, id)?.warnings).toEqual([
        expect.stringMatching(/^tell: plugin example sent an invalid run answer/),
      ]);
      const traced = published.filter((e) => e.type === 'job.trace' && e.jobId === id);
      for (const e of traced) expect(EngineEventSchema.safeParse(e).success).toBe(true);
      const session = await login(t);
      const res = await send(t, 'GET', `/jobs/${id}`, { headers: asSession(session, false) });
      expect(res.status).toBe(200);
      const { token } = await createToken(t, session, { name: 'm', scopes: ['read'] });
      const mcp = await mcpClient(t, token);
      const got = await mcp.callTool({ name: 'get_job', arguments: { id } });
      expect(got.isError).toBeFalsy();
    },
  );

  it('a plugin step of a node pinned to an older version reaches the remote run call with that node version and its stored settings', async () => {
    const calls: Array<{ hook: string; version: number; settings: unknown }> = [];
    const remote = remoteNodeDefinition(
      {
        type: 'example:rnote',
        version: 2,
        kind: 'finish',
        title: 'Remote note',
        description: 'A plugin finish node.',
        icon: 'bell',
        inputs: [filePort],
        outputs: [],
        settingsSchema: { type: 'object', properties: { room: { type: 'string' } } },
        onNodeSettings: [],
        requires: {},
        migrations: [{ from: 1, to: 2, risk: 'safe', note: 'renamed' }],
        finishPhase: 'notify',
        hooks: ['finish', 'run'],
      },
      SOURCE,
      {
        async call(hook, _type, version, _ctx, settings) {
          calls.push({ hook, version, settings });
          return hook === 'finish'
            ? {
                ok: true,
                result: {
                  actions: [{ kind: 'plugin', description: 'tell', required: false }],
                  reason: 'queued',
                },
              }
            : { ok: true, result: { ok: true, message: 'noted' } };
        },
      },
      { callTimeoutMs: 1000, finishRunTimeoutMs: 1000 },
    );
    await t.deps.engine.stop();
    await setup({
      extra: [...entries(), { def: remote, source: SOURCE }],
      hooks: hooksRunner(),
    });
    // `old` is not a field of the v2 schema: it goes to the host as stored, at version 1.
    const id = await queue(
      file(),
      encodeAnd(replaceNode(), node('pn', 'example:rnote', { old: 'room-b' })),
    );
    expect(await runOnce(id)).toMatchObject({ state: 'done' });
    expect(calls.map((c) => [c.hook, c.version, c.settings])).toEqual([
      ['finish', 1, { old: 'room-b' }],
      ['run', 1, { old: 'room-b' }],
    ]);
  });

  it('a required step that fails ends done "finished with a problem: <message>", stores the problem and emits job.changed with it', async () => {
    runImpl = async () => ({ ok: false, message: 'room b did not answer' });
    const id = await queue(file(), withNote({ required: true }));
    const job = await runOnce(id);
    expect(job).toMatchObject({
      state: 'done',
      reason: 'finished with a problem: room b did not answer',
    });
    expect(findJobResult(t.db, id)?.problems).toEqual(['room b did not answer']);
    // Told on the step's node too: the job page badges it.
    expect(findJobResult(t.db, id)?.nodeProblems).toEqual([
      { workflowPath: [], nodeId: 'pn', severity: 'problem', message: 'room b did not answer' },
    ]);
    expect((await stat(file())).size).toBe(600);
    const last = published.filter((e) => e.type === 'job.changed' && e.jobId === id).at(-1);
    expect(last).toMatchObject({ state: 'done', problems: ['room b did not answer'] });
  });

  it('a best-effort step that fails is a warning, not a problem', async () => {
    runImpl = async () => ({ ok: false, message: 'room b did not answer' });
    const id = await queue(file(), withNote());
    const job = await runOnce(id);
    expect(job).toMatchObject({ state: 'done', reason: null });
    expect(findJobResult(t.db, id)).toMatchObject({
      problems: [],
      warnings: ['tell room b: room b did not answer'],
      nodeProblems: [
        {
          workflowPath: [],
          nodeId: 'pn',
          severity: 'warning',
          message: 'tell room b: room b did not answer',
        },
      ],
    });
  });

  it('a retryable required failure is retried once after 10 s and then recorded', async () => {
    const delays = fastPluginRetry();
    let n = 0;
    runImpl = async () =>
      ++n === 1 ? { ok: false, message: 'busy', retryable: true } : { ok: true, message: 'noted' };
    const id = await queue(file(), withNote({ required: true }));
    const job = await runOnce(id);
    expect(job).toMatchObject({ state: 'done', reason: null });
    expect(runCalls).toHaveLength(2);
    expect(delays).toContain(PLUGIN_RETRY_MS);
    expect(findJobResult(t.db, id)?.problems).toEqual([]);

    // Failing twice: one problem, two calls.
    await t.deps.engine.stop();
    await setup({ extra: entries(), hooks: hooksRunner() });
    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    runCalls = [];
    runImpl = async () => ({ ok: false, message: 'busy', retryable: true });
    const id2 = await queue(join(root, 'Show', 'b.mkv'), withNote({ required: true }));
    const job2 = await runOnce(id2);
    expect(job2).toMatchObject({ state: 'done', reason: 'finished with a problem: busy' });
    expect(runCalls).toHaveLength(2);
    expect(findJobResult(t.db, id2)?.problems).toEqual(['busy']);
  });

  it('a best-effort retryable failure is not retried', async () => {
    runImpl = async () => ({ ok: false, message: 'busy', retryable: true });
    const id = await queue(file(), withNote());
    await runOnce(id);
    expect(runCalls).toHaveLength(1);
  });

  it('a test-encode never calls a plugin finish step or a job hook', async () => {
    const id = await queue(file(), withNote({ required: true }), {
      dryRun: true,
      testEncode: true,
    });
    expect(await runOnce(id)).toMatchObject({ state: 'dry_run' });
    expect(runCalls).toEqual([]);
    await new Promise((r) => setTimeout(r, 200));
    expect(hookCalls).toEqual([]);
  });

  it('a dry run never calls run, a plugin hook or the job hooks', async () => {
    const id = await queue(file(), withNote({ required: true }), { dryRun: true });
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'dry_run' });
    expect(spawner.calls).toEqual([]);
    expect(runCalls).toEqual([]);
    expect(hookCalls).toEqual([]);
  });

  it('afterReplace runs right after the write and before the plugin step; onJobDone after the result row carries problems; none on a dry run', async () => {
    runImpl = async () => ({ ok: false, message: 'nope' });
    const id = await queue(file(), withNote({ required: true }));
    await runOnce(id);
    await until('onJobDone', () => hookCalls.some((c) => c.hook === 'onJobDone'));
    expect(order).toEqual(['afterReplace', 'run', 'onJobDone']);
    const after = hookCalls.find((c) => c.hook === 'afterReplace');
    expect(after?.job).toMatchObject({
      id,
      outcome: 'replaced',
      problems: [],
      beforeBytes: 1000,
      afterBytes: 600,
      replacedTo: 'recycle',
      workflowVersion: 2,
      path: file(),
      dryRun: false,
    });
    const done = hookCalls.find((c) => c.hook === 'onJobDone');
    expect(done?.job).toMatchObject({
      outcome: 'done',
      problems: ['nope'],
      workflowName: expect.any(String),
    });
    expect(done?.resultProblems).toEqual(['nope']);
  });

  it('onJobFailed runs for a failed job (after its row is written), onJobDone does not', async () => {
    fake.brokenOutput = true;
    const id = await queue(file(), withNote());
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length >= 1);
    await spawner.complete({ bytes: 600 });
    // verify fails twice (attempt 2 too).
    await until('second spawn', () => spawner.calls.length >= 2);
    await spawner.complete({ bytes: 600 });
    expect((await settled(id)).state).toBe('failed');
    await until('onJobFailed', () => hookCalls.some((c) => c.hook === 'onJobFailed'));
    expect(hookCalls.map((c) => c.hook)).toEqual(['onJobFailed']);
    expect(hookCalls[0]?.job).toMatchObject({ outcome: 'failed', problems: [] });
    expect(hookCalls[0]?.job.reason).toMatch(/^verify:/);
  });

  it('a stop (shutdown) during a plugin step ends done "the server stopped before the remaining finish actions" within the stop, and the step is not re-run on the next start', async () => {
    runImpl = () => new Promise(() => {});
    const id = await queue(file(), withNote({ required: true }));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('run called', () => runCalls.length === 1);
    await t.deps.engine.stop();
    expect(row(id)).toMatchObject({
      state: 'done',
      reason: 'finished with a problem: the server stopped before the remaining finish actions',
    });
    expect(findJobResult(t.db, id)?.problems).toEqual([
      'the server stopped before the remaining finish actions',
    ]);
    expect((await stat(file())).size).toBe(600);
    // No job hook is sent while the server is going down.
    expect(hookCalls.map((c) => c.hook)).toEqual(['afterReplace']);
    // The next start finds a done job: no second encode, replace or step.
    await t.deps.engine.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(spawner.calls).toHaveLength(1);
    expect(runCalls).toHaveLength(1);
    expect(row(id).state).toBe('done');
  });

  it('a user cancel during a plugin step ends done "cancel before the remaining finish actions" and onJobDone fires', async () => {
    runImpl = () => new Promise(() => {});
    const id = await queue(file(), withNote({ required: true }));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('run called', () => runCalls.length === 1);
    // The job's own signal rides on the server-side context (never on the wire): a cancel aborts it.
    const signal = (runCalls[0] as { signal?: AbortSignal } | undefined)?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(t.deps.engine.scheduler.cancelJob(id)).toBe('ok');
    const job = await settled(id);
    expect(signal?.aborted).toBe(true);
    expect(job).toMatchObject({
      state: 'done',
      reason: 'finished with a problem: cancel before the remaining finish actions',
    });
    expect(findJobResult(t.db, id)?.problems).toEqual([
      'cancel before the remaining finish actions',
    ]);
    expect((await stat(file())).size).toBe(600);
    await until('onJobDone', () => hookCalls.some((c) => c.hook === 'onJobDone'));
    expect(hookCalls.find((c) => c.hook === 'onJobDone')?.job.problems).toEqual([
      'cancel before the remaining finish actions',
    ]);
  });

  it('a run() that throws after the write becomes a problem (required) or a warning (best effort), never "internal error"', async () => {
    runImpl = async () => {
      throw new RemoteHookError('plugin example crashed', false);
    };
    const id = await queue(file(), withNote({ required: true }));
    const job = await runOnce(id);
    expect(job).toMatchObject({
      state: 'done',
      reason: 'finished with a problem: plugin example crashed',
    });
    expect(findJobResult(t.db, id)?.problems).toEqual(['plugin example crashed']);

    await t.deps.engine.stop();
    await setup({ extra: entries(), hooks: hooksRunner() });
    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    const id2 = await queue(join(root, 'Show', 'b.mkv'), withNote());
    const job2 = await runOnce(id2);
    expect(job2).toMatchObject({ state: 'done', reason: null });
    expect(findJobResult(t.db, id2)).toMatchObject({
      problems: [],
      warnings: ['tell room b: plugin example crashed'],
    });
  });

  it('a plugin that is down at the step is a problem after the write (never undone, never silent)', async () => {
    runImpl = async () => ({ ok: true, message: 'unreachable' });
    const id = await queue(file(), withNote({ required: true }));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    // The plugin dies between the encode and the step (a retry would find it still down).
    pluginDown = 'plugin example is not running: exited with code 3';
    fastPluginRetry();
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job).toMatchObject({
      state: 'done',
      reason: 'finished with a problem: plugin example is not running: exited with code 3',
    });
    expect(runCalls).toEqual([]);
    expect((await stat(file())).size).toBe(600);
  });

  it('move-copy: run() sees newPath = the destination and outcome moved|copied; afterReplace gets the same outcome', async () => {
    for (const mode of ['copy', 'move'] as const) {
      await t.deps.engine.stop();
      await setup({ extra: entries(), hooks: hooksRunner() });
      runCalls = [];
      hookCalls = [];
      const name = `${mode}.mkv`;
      await writeFile(join(root, 'Show', name), Buffer.alloc(1000, 7));
      const id = await queue(
        join(root, 'Show', name),
        encodeAnd(moveCopy(mode), node('pn', 'example:note', {})),
      );
      const job = await runOnce(id);
      expect(job.state).toBe('done');
      expect(runCalls[0]).toMatchObject({
        originalPath: join(root, 'Show', name),
        newPath: join(base, 'out', 'Show', name),
        outcome: mode === 'move' ? 'moved' : 'copied',
        replacedTo: null,
        afterBytes: 600,
      });
      expect(hookCalls.find((c) => c.hook === 'afterReplace')?.job.outcome).toBe(
        mode === 'move' ? 'moved' : 'copied',
      );
      spawner.calls.length = 0;
    }
  });

  it('[activation] a real job whose active version has a stopped plugin fails at start with workflow invalid and names the plugin', async () => {
    const wf = withNote();
    t.deps.engine.scheduler.pauseQueue();
    const id = await queue(file(), wf);
    pluginDown = 'plugin example is not running: stopped after 3 crashes';
    await t.deps.engine.start();
    t.deps.engine.scheduler.resumeQueue();
    const job = await settled(id);
    expect(job.state).toBe('failed');
    expect(job.failureCode).toBe('workflow');
    expect(job.reason).toMatch(/^workflow invalid: .*plugin example is not running/);
    expect(spawner.calls).toEqual([]);
    expect(runCalls).toEqual([]);
    expect((await stat(file())).size).toBe(1000);
  });

  it('a retryable remote hook failure while building is retried as attempt 2; a non-retryable one fails the job', async () => {
    let n = 0;
    actImpl = async () => {
      if (++n === 1) throw new RemoteHookError('plugin example restarting', true);
    };
    const wf = encodeAnd(node('ac', 'example:act'), replaceNode());
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done', attempt: 2 });
    expect(states(id)).toContain('queued');

    await t.deps.engine.stop();
    await setup({ extra: entries(), hooks: hooksRunner() });
    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    actImpl = async () => {
      throw new RemoteHookError('plugin example rejected the file', false);
    };
    const id2 = await queue(
      join(root, 'Show', 'b.mkv'),
      encodeAnd(node('ac', 'example:act'), replaceNode()),
    );
    await t.deps.engine.start();
    const failed = await settled(id2);
    expect(failed).toMatchObject({ state: 'failed', failureCode: 'workflow', attempt: 1 });
    expect(failed.reason).toBe('ac: plugin example rejected the file');
  });
});

describe('pipeline: a real plugin host', () => {
  /** The example plugin with a `run` that never answers. */
  async function hangingPlugin(): Promise<string> {
    const code = readFileSync(fixturePluginPath('example'), 'utf8').replace(
      'async run(ctx, settings) {',
      'async run(ctx, settings) {\n\t\tawait new Promise(() => {});',
    );
    expect(code).toContain('await new Promise(() => {});');
    const bundle = join(base, 'example-hang.js');
    await writeFile(bundle, code);
    return bundle;
  }

  /** The example plugin whose condition takes `ms` to decide (a window to kill it in). */
  async function slowDecidePlugin(ms: number): Promise<string> {
    const code = readFileSync(fixturePluginPath('example'), 'utf8').replace(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the bundled plugin's source text, matched literally.
      'await ctx.plugin.log("debug", `checking ${ctx.file.path}`);',
      `await ctx.plugin.log('debug', 'checking');\n\tawait new Promise((r) => setTimeout(r, ${ms}));`,
    );
    expect(code).toContain(`setTimeout(r, ${ms})`);
    const bundle = join(base, 'example-slow.js');
    await writeFile(bundle, code);
    return bundle;
  }

  it('a plugin killed (kill -9) while a job is in decide: the job is retried once the plugin is back and ends done', async () => {
    const bundle = await slowDecidePlugin(1500);
    await t.deps.engine.stop();
    await setup({ plugins: { devPlugins: [bundle] } });
    await t.deps.plugins.start();
    expect(t.deps.plugins.get('example')?.state).toBe('running');
    const pid = t.deps.plugins.pid('example');
    if (!pid) throw new Error('the plugin has no process');
    const wf = workflow(
      mainGraph(
        [
          node('in', 'core:input-manual'),
          node('ex', 'example:extension-is'),
          toH264(),
          replaceNode(),
        ],
        [edge('in', 'ex'), edge('ex', 'ev', { from: 'pass' }), edge('ev', 'ro')],
      ),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('deciding', () => row(id).state === 'deciding');
    await new Promise((r) => setTimeout(r, 300));
    process.kill(pid, 'SIGKILL');
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done', attempt: 2 });
    expect(t.deps.plugins.get('example')?.state).toBe('running');
  });

  it('Review focus 2: a stop while a plugin run is in flight ends the job done with the problem, kills the plugin process, and the next start does not repeat the write', async () => {
    const bundle = await hangingPlugin();
    await t.deps.engine.stop();
    await setup({ plugins: { devPlugins: [bundle] } });
    await t.deps.plugins.start();
    expect(t.deps.plugins.get('example')?.state).toBe('running');
    const pid = t.deps.plugins.pid('example');
    if (!pid) throw new Error('the plugin has no process');

    const id = await queue(
      file(),
      encodeAnd(replaceNode(), node('pn', 'example:note', { required: true })),
    );
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('written', async () =>
      stat(file()).then(
        (st) => st.size === 600,
        () => false,
      ),
    );
    // The step is in the plugin now and never answers.
    await new Promise((r) => setTimeout(r, 400));
    expect(row(id).state).not.toBe('done');

    await t.deps.engine.stop();
    expect(row(id)).toMatchObject({
      state: 'done',
      reason: 'finished with a problem: the server stopped before the remaining finish actions',
    });
    expect(findJobResult(t.db, id)?.problems).toEqual([
      'the server stopped before the remaining finish actions',
    ]);
    await t.deps.plugins.stop();
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await stat(file())).size).toBe(600);

    await t.deps.engine.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(spawner.calls).toHaveLength(1);
    expect(row(id).state).toBe('done');
  });
});
