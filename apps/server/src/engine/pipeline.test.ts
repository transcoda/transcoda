import { readdirSync, readFileSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { type Capabilities, EngineEventSchema } from '@transcoda/contract';
import {
  type AnyNodeDefinition,
  defineNode,
  type FinishRunContext,
  type FinishRunResult,
  type HookJob,
  type ProbeResult,
} from '@transcoda/sdk';
import { type JobState, type JsonValue, planSummary, type WorkflowGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Exec } from '../capabilities/ffmpeg.ts';
import {
  findJob,
  findJobResult,
  hasReplaceJournal,
  insertJob,
  insertJobResult,
  type JobRow,
  listRecycled,
  listTrace,
  updateJob,
} from '../db/repos/jobs.ts';
import type { LibraryRow } from '../db/repos/libraries.ts';
import { setSetting } from '../db/repos/settings.ts';
import type { Logger } from '../logger.ts';
import { mcpClient } from '../mcp/test-client.ts';
import { filePort } from '../nodes/core/common.ts';
import { setOrder } from '../nodes/core/stream-rules.ts';
import type { RegisteredNode } from '../nodes/registry.ts';
import { RemoteHookError, remoteNodeDefinition } from '../nodes/remote.ts';
import { type HookName, PluginHooksRunner } from '../plugins/hooks.ts';
import { fixturePluginPath } from '../plugins/testing/build.ts';
import { createTestApp, type TestApp } from '../test-app.ts';
import { asSession, createToken, login, send } from '../test-http.ts';
import { chain, edge, mainGraph, node, testRegistry } from '../workflows/test-helpers.ts';
import { fitToContainer, modelFromProbe, normalizeDefaults } from './build-model.ts';
import type { EngineEvent } from './events.ts';
import { fingerprintKey, fingerprintOf } from './fingerprint.ts';
import { tempDir } from './fixtures.ts';
import { type FsOps, nodeFsOps } from './fs-ops.ts';
import {
  classifyErrorLine,
  coverFailure,
  coverTimeoutMs,
  estimateBytes,
  laneFor,
  PLUGIN_RETRY_MS,
  planOf,
  redactUrl,
} from './pipeline.ts';
import { FakeSpawner, type RunnerProcess, type SpawnOptions } from './process.ts';
import { probeOf, withSidecar, withStream } from './test-helpers.ts';

/** How long `until` waits; well above any healthy run, below the raised test timeout. */
const UNTIL_MS = 10_000;
vi.setConfig({ testTimeout: 30_000 });

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '9.0.2',
  encoders: ['aac', 'libx264', 'libx265', 'h264_nvenc'],
  hwaccels: [],
  filters: ['pan'],
};

/** ffprobe's JSON for a hand-built probe (what parseProbe reads back). */
function ffprobeJson(p: ProbeResult): unknown {
  return {
    format: {
      format_name: p.formatName,
      duration: p.durationSeconds.toFixed(6),
      size: String(p.sizeBytes),
      start_time: '0.000000',
    },
    streams: p.streams.map((s) => ({
      index: s.index,
      codec_type: s.type,
      codec_name: s.codec,
      disposition: {
        default: s.default ? 1 : 0,
        forced: s.forced ? 1 : 0,
        attached_pic: s.attachedPic ? 1 : 0,
      },
      tags: {
        ...(s.language ? { language: s.language } : {}),
        ...(s.title ? { title: s.title } : {}),
      },
    })),
  };
}

/** A data node that names the original language. */
const originalLanguage: AnyNodeDefinition = defineNode({
  type: 'test:original-language',
  version: 1,
  kind: 'data',
  title: 'Original language',
  description: 'Test data node.',
  icon: 'test',
  inputs: [],
  outputs: [{ id: 'language', label: 'Language', type: 'data:language' }],
  settings: z.object({}),
  async data() {
    return { value: 'jpn', reason: 'test metadata' };
  },
});

/** An action that writes a model renderArgs refuses (a stray global argument). */
const strayArg: AnyNodeDefinition = defineNode({
  type: 'test:stray-arg',
  version: 1,
  kind: 'action',
  title: 'Stray arg',
  description: 'Test action.',
  icon: 'test',
  inputs: [{ id: 'file', label: 'File', type: 'file' }],
  outputs: [{ id: 'file', label: 'File', type: 'file' }],
  settings: z.object({}),
  async build(ctx) {
    return {
      model: { ...ctx.model, container: 'mp4', globalArgs: ['stray'] },
      reason: 'stray argument',
    };
  },
});

/** An action that sets the first stream's profile and pixel format (no core node sets a profile). */
const setProfile: AnyNodeDefinition = defineNode({
  type: 'test:set-profile',
  version: 1,
  kind: 'action',
  title: 'Set profile',
  description: 'Test action.',
  icon: 'test',
  inputs: [{ id: 'file', label: 'File', type: 'file' }],
  outputs: [{ id: 'file', label: 'File', type: 'file' }],
  settings: z.object({ profile: z.string(), pixelFormat: z.string() }),
  async build(ctx, settings) {
    const streams = ctx.model.streams.map((s, i) =>
      i === 0 ? { ...s, profile: settings.profile, pixelFormat: settings.pixelFormat } : s,
    );
    return { model: { ...ctx.model, streams }, reason: 'set the profile' };
  },
});

/** A core-style action that adds one sidecar subtitle (stands in for the embed node of Task 1b). */
const addSidecar: AnyNodeDefinition = defineNode({
  type: 'test:add-sidecar',
  version: 1,
  kind: 'action',
  title: 'Add sidecar',
  description: 'Test action.',
  icon: 'test',
  inputs: [{ id: 'file', label: 'File', type: 'file' }],
  outputs: [{ id: 'file', label: 'File', type: 'file' }],
  settings: z.object({ path: z.string() }),
  async build(ctx, settings) {
    const model = withSidecar(ctx.model, 1, 'a.de.srt');
    (model.extraInputs?.[0] as { path: string }).path = settings.path;
    return { model, reason: 'added a sidecar' };
  },
});

/** FakeSpawner whose processes the test completes by writing the output (and a log). */
/**
 * FakeSpawner whose processes the test completes: stderr lines are delivered live and appended to
 * the job log (the real spawner appends too), `leading` ones before any progress, `stderr` ones
 * after a progress sample at `at` seconds with frames written; then the output is written (a copy
 * of the input, or `bytes` bytes) and the process exits.
 */
class TestSpawner extends FakeSpawner {
  async complete(
    o: { bytes?: number; code?: number; leading?: string[]; stderr?: string[]; at?: number } = {},
  ): Promise<void> {
    const call = this.calls.at(-1);
    if (!call) throw new Error('nothing spawned');
    const input = call.args[call.args.indexOf('-i') + 1] as string;
    const output = call.args.at(-1) as string;
    const emit = async (lines: string[]) => {
      for (const l of lines) this.emitStderr(l);
      if (lines.length > 0) await appendFile(call.logPath, `${lines.join('\n')}\n`);
    };
    await emit(o.leading ?? []);
    if (o.stderr) {
      this.emitProgress({
        outTimeSeconds: o.at ?? 30,
        speed: 1,
        fps: 25,
        sizeBytes: 100,
        frames: 25 * (o.at ?? 30),
      });
      await emit(o.stderr);
    }
    if (o.bytes === undefined) await writeFile(output, await readFile(input));
    else await writeFile(output, Buffer.alloc(o.bytes, 1));
    this.exit(o.code ?? 0);
  }
}

const SECRET = 'tok3n-s3cr3t';

let base: string;
let root: string;
let transcodeDir: string;
let configDir: string;
let t: TestApp;
let spawner: TestSpawner;
let published: EngineEvent[];
/** The server log of the current `setup`. */
let serverLog: Logger;
let sourceProbe: ProbeResult;
let outputProbe: ProbeResult;
/** Output packet reads answer '' (the output ends early): verify fails duration. */
let brokenOutput: boolean;
let coverExtracts: boolean;
let fsOps: FsOps;
let lib: LibraryRow;
const execCalls: string[][] = [];
/** Source decodes at a spot (`-ss`) report a decoder error (the source really is damaged there). */
let sourceSpotsDamaged: boolean;
/** Runs first for every exec call; may answer (return a result) or hang. */
let execHook:
  | ((
      file: string,
      args: string[],
      signal: AbortSignal | undefined,
    ) => Promise<{ stdout: string; stderr: string } | null>)
  | null;
/** Signals passed with exec calls, for the cancel/shutdown tests. */
const execSignals: (AbortSignal | undefined)[] = [];

const fakeExec: Exec = async (file, args, opts) => {
  execCalls.push([file, ...args]);
  execSignals.push(opts?.signal);
  const hooked = execHook ? await execHook(file, args, opts?.signal) : null;
  if (hooked) return hooked;
  const path = args.at(-1) as string;
  const isOutput = path.startsWith(transcodeDir);
  if (
    file === 'ffmpeg' &&
    sourceSpotsDamaged &&
    args.includes('-ss') &&
    args.join(' ').includes(` -i ${root}`)
  ) {
    throw Object.assign(new Error('Command failed'), {
      stderr: '[h264 @ 0x1] error while decoding MB 15 10\n',
    });
  }
  if (args.includes('-show_format')) {
    return {
      stdout: JSON.stringify(ffprobeJson(isOutput ? outputProbe : sourceProbe)),
      stderr: '',
    };
  }
  const at = args.indexOf('-read_intervals');
  if (at >= 0 && args.includes('packet=pts_time,duration_time')) {
    if (isOutput && brokenOutput) return { stdout: '', stderr: '' };
    return { stdout: '59.960000,0.040000\n', stderr: '' };
  }
  if (at >= 0) return { stdout: '55.000000,1000,K__\n', stderr: '' };
  if (args.includes('image2')) {
    if (coverExtracts) await writeFile(path, 'png');
    return { stdout: '', stderr: '' };
  }
  return { stdout: '', stderr: '' };
};

/**
 * Polls `pred` every 5 ms for up to {@link UNTIL_MS} (a fast run costs nothing; a loaded machine,
 * e.g. `pnpm check` with the real-ffmpeg suites in parallel, gets time). The test timeout is raised
 * to match (vi.setConfig below).
 */
async function until(what: string, pred: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + UNTIL_MS;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function row(id: string): JobRow {
  const r = findJob(t.db, id);
  if (!r) throw new Error(`no job ${id}`);
  return r;
}

const FINAL: JobState[] = [
  'done',
  'nothing_to_do',
  'kept_original',
  'failed',
  'cancelled',
  'dry_run',
  'skipped',
  'already_processed',
];
async function settled(id: string): Promise<JobRow> {
  await until(`job ${id} to finish`, () => FINAL.includes(row(id).state));
  return row(id);
}

/** The job's states from job.changed events, consecutive repeats removed. */
function states(id: string): JobState[] {
  const out: JobState[] = [];
  for (const e of published) {
    if (e.type === 'job.changed' && e.jobId === id && out.at(-1) !== e.state) out.push(e.state);
  }
  return out;
}

function workflow(graph: WorkflowGraph, active = true): string {
  const { id } = t.deps.workflows.create({ name: `wf-${Math.random()}`, kind: 'workflow' }, 'u');
  const saved = t.deps.workflows.save({ id, baseVersion: 1, graph }, 'u');
  expect(saved.version).toBe(2);
  if (active) expect(t.deps.workflows.activate(id, 2, 'u').kind).toBe('ok');
  return id;
}

const line = (...nodes: ReturnType<typeof node>[]): WorkflowGraph =>
  mainGraph(
    nodes,
    nodes.slice(1).map((n, i) => {
      const from = nodes[i] as ReturnType<typeof node>;
      // The size gate's file leaves by `pass`.
      return edge(from.id, n.id, from.type === 'core:size-gate' ? { from: 'pass' } : {});
    }),
  );

/** in → encode → gate; gate.pass → `passSteps`; gate.else → `elseSteps` (each chain in order). */
const gated = (
  minSavingPercent: number,
  passSteps: ReturnType<typeof node>[],
  elseSteps: ReturnType<typeof node>[],
): WorkflowGraph => {
  const gate = node('sg', 'core:size-gate', { minSavingPercent });
  const nodes = [node('in', 'core:input-manual'), toH264(), gate, ...passSteps, ...elseSteps];
  const edges = [
    edge('in', 'ev'),
    edge('ev', 'sg'),
    ...passSteps.map((n, i) =>
      edge(
        i === 0 ? 'sg' : (passSteps[i - 1] as { id: string }).id,
        n.id,
        i === 0 ? { from: 'pass' } : {},
      ),
    ),
    ...elseSteps.map((n, i) =>
      edge(
        i === 0 ? 'sg' : (elseSteps[i - 1] as { id: string }).id,
        n.id,
        i === 0 ? { from: 'else' } : {},
      ),
    ),
  ];
  return mainGraph(nodes, edges);
};

const toH264 = () =>
  node('ev', 'core:encode-video', { codec: 'h264', encoder: 'libx264', skipIf: 'never' });

async function queue(
  path: string,
  workflowId: string,
  extra: { dryRun?: boolean; force?: boolean; testEncode?: boolean } = {},
): Promise<string> {
  const r = await t.deps.engine.queue.queue({
    path,
    workflowId,
    dryRun: extra.dryRun ?? false,
    force: extra.force ?? false,
    ...(extra.testEncode !== undefined ? { testEncode: extra.testEncode } : {}),
    priority: 0,
    createdBy: 'u',
  });
  if (r.kind !== 'queued') throw new Error(`not queued: ${JSON.stringify(r)}`);
  return (r.jobs[0] as JobRow).id;
}

async function listAll(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      out.push(p.slice(dir.length));
      if (e.isDirectory()) await walk(p);
    }
  };
  await walk(dir);
  return out.sort();
}

async function setup(
  opts: {
    nodes?: AnyNodeDefinition[];
    /** Registry entries as given (plugin-sourced ones, with `unavailable`). */
    extra?: RegisteredNode[];
    hooks?: PluginHooksRunner;
    fs?: FsOps;
    puid?: number;
    publicUrl?: string;
    settleMinutes?: number;
    /** Real plugins: bundles to load as dev plugins (the caller starts the plugin service). */
    plugins?: { devPlugins?: string[] };
    capabilities?: Capabilities;
  } = {},
) {
  spawner = new TestSpawner();
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  serverLog = log;
  fsOps = opts.fs ?? fsOps;
  t = createTestApp({
    config: {
      configDir,
      transcodeDir,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      outputRoots: [join(base, 'out')],
      ...(opts.puid !== undefined ? { puid: opts.puid, pgid: opts.puid } : {}),
      ...(opts.publicUrl !== undefined ? { publicUrl: opts.publicUrl } : {}),
    },
    capabilities: opts.capabilities ?? caps,
    spawner,
    fsOps,
    exec: fakeExec,
    log,
    ...(opts.settleMinutes !== undefined ? { settleMinutes: opts.settleMinutes } : {}),
    nodes: [
      ...testRegistry(originalLanguage, strayArg, addSidecar, ...(opts.nodes ?? [])).list(),
      ...(opts.extra ?? []),
    ],
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.plugins ? { plugins: opts.plugins } : {}),
  });
  published = [];
  const publish = t.deps.engine.events.publish.bind(t.deps.engine.events);
  vi.spyOn(t.deps.engine.events, 'publish').mockImplementation((e) => {
    published.push(e);
    publish(e);
  });
  const created = await t.deps.engine.queue.createLibrary({ name: 'Lib', path: root });
  if ('kind' in created) throw new Error('library not created');
  lib = created;
}

beforeEach(async () => {
  base = await tempDir('pipeline-');
  root = join(base, 'lib');
  transcodeDir = join(base, 'transcode');
  configDir = join(base, 'config');
  await mkdir(join(root, 'Show'), { recursive: true });
  await mkdir(join(base, 'outside'), { recursive: true });
  await writeFile(join(root, 'Show', 'a.mkv'), Buffer.alloc(1000, 7));
  sourceProbe = probeOf(
    [
      { type: 'video', codec: 'hevc', default: true },
      { type: 'audio', codec: 'aac', language: 'eng', default: true },
    ],
    { sizeBytes: 1000 },
  );
  outputProbe = probeOf(
    [
      { type: 'video', codec: 'h264', default: true },
      { type: 'audio', codec: 'aac', language: 'eng', default: true },
    ],
    { sizeBytes: 600 },
  );
  brokenOutput = false;
  coverExtracts = true;
  sourceSpotsDamaged = false;
  execHook = null;
  execCalls.length = 0;
  execSignals.length = 0;
  // Plenty of room: the replace needs 5 GiB beyond the output on the original's filesystem.
  fsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) };
  await setup();
});

afterEach(async () => {
  await t.deps.engine.stop();
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

const file = (): string => join(root, 'Show', 'a.mkv');

describe('pipeline', () => {
  it('nothing to do: identity model ends nothing_to_do after building, no lane, file untouched', async () => {
    const wf = workflow(line(node('in', 'core:input-manual'), node('ro', 'core:replace-original')));
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'nothing_to_do', lane: null, reason: 'already as planned' });
    expect(states(id)).toEqual(['probing', 'deciding', 'building', 'nothing_to_do']);
    expect(spawner.calls).toEqual([]);
    expect(findJobResult(t.db, id)).toMatchObject({
      outcome: 'nothing_to_do',
      plan: { rewrite: false },
    });
    expect((await stat(file())).size).toBe(1000);
  });

  it('a changed model on a path without replace/move ends kept_original "path never writes the result" without spawning ffmpeg', async () => {
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        toH264(),
        node('sg', 'core:size-gate', { minSavingPercent: 10 }),
      ),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({
      state: 'kept_original',
      reason: 'path never writes the result',
    });
    expect(spawner.calls).toEqual([]);
    // The trace shows the build.
    expect(listTrace(t.db, id).map((e) => [e.nodeId, e.phase])).toEqual([
      ['in', 'pass'],
      ['ev', 'build'],
      ['sg', 'finish'],
    ]);
  });

  it('dry run: ends dry_run with the rendered command, a per-stream plan (drop/convert/keep, default before/after, isOriginalLanguage), an estimate from history and the owner warning; nothing written', async () => {
    await t.deps.engine.stop();
    const uid = (await stat(file())).uid;
    await setup({ puid: uid + 1 });
    sourceProbe = probeOf(
      [
        { type: 'video', codec: 'hevc', default: true },
        { type: 'audio', codec: 'aac', language: 'fra', default: true },
        { type: 'audio', codec: 'aac', language: 'jpn' },
        { type: 'audio', codec: 'aac', language: 'eng' },
      ],
      { sizeBytes: 1000 },
    );
    const graph = mainGraph(
      [
        node('in', 'core:input-manual'),
        node('lang', 'test:original-language'),
        node('kl', 'core:keep-languages', { languages: ['en'] }),
        toH264(),
        node('ro', 'core:replace-original'),
      ],
      [
        edge('in', 'kl'),
        edge('lang', 'kl', { from: 'language', to: 'language' }),
        edge('kl', 'ev'),
        edge('ev', 'ro'),
      ],
    );
    const wf = workflow(graph);
    // History: one done result of this workflow at half the size.
    const prior = insertJob(
      t.db,
      {
        id: 'prior',
        runId: (await t.deps.engine.queue
          .queue({
            path: file(),
            workflowId: wf,
            dryRun: true,
            force: true,
            priority: 0,
            createdBy: 'u',
          })
          .then((r) => (r.kind === 'queued' ? r.run.id : ''))) as string,
        libraryId: lib.id,
        fileId: null,
        path: '/elsewhere.mkv',
        workflowId: wf,
        workflowVersion: 2,
        dryRun: false,
        testEncode: false,
        state: 'done',
        priority: 0,
      },
      t.clock.now(),
    );
    insertJobResult(t.db, {
      jobId: prior.id,
      fingerprint: 'x',
      workflowId: wf,
      workflowVersion: 2,
      outcome: 'done',
      beforeBytes: 2000,
      afterBytes: 1000,
      estimatedBytes: null,
      command: null,
      plan: null,
      replacedTo: 'recycle',
      logPath: null,
      warnings: [],
      problems: [],
      outputProbe: null,
      createdAt: t.clock.now().toISOString(),
    });
    const before = await listAll(base);
    const id = await queue(file(), wf, { dryRun: true });
    await t.deps.engine.start();
    const job = await settled(id);
    expect(job.state).toBe('dry_run');
    const result = findJobResult(t.db, id);
    expect(result?.command).toMatch(/^ffmpeg -loglevel level\+warning .*-c:0 libx264/);
    expect(result?.estimatedBytes).toBe(500);
    expect(result?.warnings).toEqual([`owner would change from ${uid} to ${uid + 1}`]);
    expect(result?.plan?.streams).toEqual([
      expect.objectContaining({ index: 0, type: 'video', codec: 'h264', action: 'convert' }),
      expect.objectContaining({
        index: 1,
        language: 'fra',
        action: 'drop',
        isOriginalLanguage: false,
        default: { before: true, after: false },
      }),
      expect.objectContaining({
        index: 2,
        language: 'jpn',
        action: 'keep',
        isOriginalLanguage: true,
        default: { before: false, after: true },
      }),
      expect.objectContaining({ index: 3, language: 'eng', action: 'keep' }),
    ]);
    expect(result?.plan?.streams[0]?.note).toMatch(/^convert hevc→h264 \(libx264/);
    // The output's tracks in output order (what the preview and the job page's player read).
    expect(result?.plan?.output).toEqual([
      { type: 'video', codec: 'h264', sourceIndex: 0, bitDepth: 8 },
      { type: 'audio', codec: 'aac', sourceIndex: 2 },
      { type: 'audio', codec: 'aac', sourceIndex: 3 },
    ]);
    expect(spawner.calls).toEqual([]);
    // Nothing written: no temp dir, no log dir, the library as it was.
    expect(await listAll(base)).toEqual(before);
  });

  it('Encoding device: auto encodes on the chosen GPU (decode too), or on the CPU when set so', async () => {
    const twoGpus: Capabilities = {
      ...caps,
      encoders: [...(caps.available ? caps.encoders : []), 'h264_nvenc'],
      hwaccels: ['cuda'],
      gpus: [
        { id: 'nvidia:0', vendor: 'nvidia', index: 0, name: 'RTX 3060' },
        { id: 'nvidia:1', vendor: 'nvidia', index: 1, name: 'RTX 3060' },
      ],
    };
    await setup({ capabilities: twoGpus });
    const autoH264 = () =>
      node('ev', 'core:encode-video', { codec: 'h264', encoder: 'auto', skipIf: 'never' });
    const wf = workflow(
      line(node('in', 'core:input-manual'), autoH264(), node('ro', 'core:replace-original')),
    );
    await t.deps.engine.start();
    const commandFor = async (device: string) => {
      setSetting(t.db, 'engine.encodeDevice', device, t.clock.now());
      const id = await queue(file(), wf, { dryRun: true, force: true });
      expect((await settled(id)).state).toBe('dry_run');
      return findJobResult(t.db, id)?.command ?? '';
    };
    const gpu1 = await commandFor('nvidia:1');
    expect(gpu1).toContain('-hwaccel cuda -hwaccel_device 1 -i');
    expect(gpu1).toMatch(/-c:0 h264_nvenc .*-gpu:0 1/);
    const cpu = await commandFor('cpu');
    expect(cpu).toContain('-c:0 libx264');
    expect(cpu).not.toContain('-hwaccel');
    // Auto, as before this setting: NVENC on ffmpeg's default GPU, no index.
    const auto = await commandFor('auto');
    expect(auto).toContain('-hwaccel cuda -i');
    expect(auto).not.toContain('-gpu');

    // CPU only and a node that names an NVENC encoder: an error, never a quiet GPU encode.
    setSetting(t.db, 'engine.encodeDevice', 'cpu', t.clock.now());
    const pinned = workflow(
      line(
        node('in', 'core:input-manual'),
        node('ev', 'core:encode-video', { codec: 'h264', encoder: 'h264_nvenc', skipIf: 'never' }),
        node('ro', 'core:replace-original'),
      ),
      false,
    );
    expect(t.deps.workflows.activate(pinned, 2, 'u').kind).toBe('invalid');
    setSetting(t.db, 'engine.encodeDevice', 'auto', t.clock.now());
    expect(t.deps.workflows.activate(pinned, 2, 'u').kind).toBe('ok');
  });

  it('two GPUs on auto: a job encodes on the GPU of the slot it got, and its command says so', async () => {
    const twoGpus: Capabilities = {
      ...caps,
      encoders: [...(caps.available ? caps.encoders : []), 'h264_nvenc'],
      hwaccels: ['cuda'],
      gpus: [
        { id: 'nvidia:0', vendor: 'nvidia', index: 0, name: 'RTX 3060' },
        { id: 'nvidia:1', vendor: 'nvidia', index: 1, name: 'RTX 3060' },
      ],
    };
    await setup({ capabilities: twoGpus });
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        node('ev', 'core:encode-video', { codec: 'h264', encoder: 'auto', skipIf: 'never' }),
        node('ro', 'core:replace-original'),
      ),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    const args = spawner.calls[0]?.args.join(' ') ?? '';
    expect(args).toContain('-hwaccel cuda -hwaccel_device 0 -i');
    expect(args).toMatch(/-c:0 h264_nvenc .*-gpu:0 0/);
    expect(t.deps.engine.scheduler.status().encodeSlots).toEqual([
      { id: 'gpu:0', label: 'GPU 0 · RTX 3060', jobId: id },
      { id: 'gpu:1', label: 'GPU 1 · RTX 3060', jobId: null },
    ]);
    await spawner.complete({ bytes: 600 });
    expect((await settled(id)).state).toBe('done');
    expect(findJobResult(t.db, id)?.command).toContain('-gpu:0 0');
  });

  describe('an NVIDIA and an Intel GPU on auto', () => {
    const mixed = (hwaccels: string[]): Capabilities => ({
      ...caps,
      encoders: [...(caps.available ? caps.encoders : []), 'hevc_nvenc', 'hevc_qsv', 'h264_qsv'],
      hwaccels,
      gpus: [
        { id: 'nvidia:0', vendor: 'nvidia', index: 0, name: 'RTX 3060' },
        {
          id: 'intel:0000:07:00.0',
          vendor: 'intel',
          index: 0,
          name: 'Intel Arc A310',
          renderNode: '/dev/dri/renderD128',
          pci: '0000:07:00.0',
        },
      ],
    });
    /** Encode video to `codec` with `encoder`; with `profile`, a later node sets it on the video. */
    const flow = (codec: 'hevc' | 'h264', encoder: string, profile?: [string, string]) =>
      workflow(
        line(
          node('in', 'core:input-manual'),
          node('ev', 'core:encode-video', { codec, encoder, skipIf: 'never' }),
          ...(profile
            ? [node('pf', 'test:set-profile', { profile: profile[0], pixelFormat: profile[1] })]
            : []),
          node('ro', 'core:replace-original'),
        ),
      );
    const hevc = (encoder: string) => flow('hevc', encoder);
    /** Runs one job of `wf` to done; its ffmpeg argv, the row's `encodedOn` and the job id. */
    const encode = async (wf: string, intelFirst: boolean, codec: 'hevc' | 'h264' = 'hevc') => {
      outputProbe = probeOf(
        [
          { type: 'video', codec, default: true },
          { type: 'audio', codec: 'aac', language: 'eng', default: true },
        ],
        { sizeBytes: 600 },
      );
      if (intelFirst) {
        setSetting(t.db, 'engine.gpuOrder', ['intel:0000:07:00.0'], t.clock.now());
      }
      const id = await queue(file(), wf);
      await t.deps.engine.start();
      await until('spawn', () => spawner.calls.length === 1);
      const args = spawner.calls[0]?.args.join(' ') ?? '';
      await spawner.complete({ bytes: 600 });
      const job = await settled(id);
      expect(job.state).toBe('done');
      return { args, encodedOn: findJob(t.db, id)?.encodedOn, id };
    };
    const planNote = (id: string) => findJobResult(t.db, id)?.plan?.streams[0]?.note ?? '';

    it('an auto HEVC job on the Intel slot encodes with QSV on that GPU and records it', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const { args, encodedOn } = await encode(hevc('auto'), true);
      expect(args).toContain('-c:0 hevc_qsv');
      expect(args).toContain('child_device=/dev/dri/renderD128');
      expect(args).not.toContain('nvenc');
      expect(args).not.toContain('-hwaccel cuda');
      expect(args).toContain('-hwaccel qsv -hwaccel_output_format qsv -i');
      expect(encodedOn).toBe('Intel Arc A310 · 07:00.0');
    });

    it('the persisted plan names the encoder the job ran with', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const { id } = await encode(hevc('auto'), true);
      expect(planNote(id)).toContain('hevc_qsv');
      expect(planNote(id)).not.toContain('nvenc');
    });

    it('a retargeted stream keeps its profile: main10 renders hevc_qsv -profile main10', async () => {
      await setup({ capabilities: mixed(['cuda']), nodes: [setProfile] });
      const { args } = await encode(flow('hevc', 'auto', ['main10', 'yuv420p10le']), true);
      expect(args).toMatch(/-c:0 hevc_qsv .*-profile:0 main10 -filter:0 vpp_qsv=format=p010/);
    });

    it('a target that cannot render encodes the built model on the slot, with a warning logged', async () => {
      await setup({ capabilities: mixed(['cuda']), nodes: [setProfile] });
      // h264_qsv has no constrained-baseline profile.
      const wf = flow('h264', 'auto', ['constrained-baseline', 'yuv420p']);
      const { args, encodedOn } = await encode(wf, true, 'h264');
      expect(args).toContain('-c:0 h264_nvenc');
      expect(args).not.toContain('h264_qsv');
      expect(serverLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: expect.stringContaining('encoding as built') }),
      );
      // NVENC on the Intel slot does not encode on that GPU.
      expect(encodedOn).toBeNull();
    });

    it('a software encode in a GPU slot records no GPU', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const { args, encodedOn } = await encode(hevc('libx265'), false);
      expect(args).toContain('-c:0 libx265');
      expect(encodedOn).toBeNull();
    });

    const NVENC_FAILED =
      '[hevc_nvenc @ 0x1] [error] OpenEncodeSessionEx failed: unsupported device (2)';
    const QSV_FAILED = '[hevc_qsv @ 0x55] [error] Error initializing an MFX session: -9.';
    /** Queues one job of `wf` and waits for its first ffmpeg; the job id. */
    const started = async (wf: string, intelFirst = false) => {
      outputProbe = probeOf(
        [
          { type: 'video', codec: 'hevc', default: true },
          { type: 'audio', codec: 'aac', language: 'eng', default: true },
        ],
        { sizeBytes: 600 },
      );
      if (intelFirst) {
        setSetting(t.db, 'engine.gpuOrder', ['intel:0000:07:00.0'], t.clock.now());
      }
      const id = await queue(file(), wf);
      await t.deps.engine.start();
      await until('spawn', () => spawner.calls.length === 1);
      return id;
    };
    const fails = (line: string) => spawner.complete({ bytes: 0, code: 1, stderr: [line] });
    const warnings = (id: string) => findJobResult(t.db, id)?.warnings ?? [];

    it('an auto job whose NVENC encode fails on gpu:0 goes back to the queue and encodes on the Intel GPU, with a warning', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const id = await started(hevc('auto'));
      expect(spawner.calls[0]?.args).toContain('hevc_nvenc');
      await fails(NVENC_FAILED);
      await until('second spawn', () => spawner.calls.length === 2);
      expect(row(id)).toMatchObject({
        attempt: 1,
        failedGpus: ['nvidia:0'],
        reason:
          'GPU 0 · RTX 3060 failed (hevc_nvenc: OpenEncodeSessionEx failed: unsupported device (2)); trying another GPU',
      });
      const args = spawner.calls[1]?.args.join(' ') ?? '';
      expect(args).toContain('-c:0 hevc_qsv');
      expect(args).not.toContain('libx265');
      await spawner.complete({ bytes: 600 });
      expect((await settled(id)).state).toBe('done');
      expect(row(id).encodedOn).toBe('Intel Arc A310 · 07:00.0');
      expect(warnings(id)).toEqual([
        'GPU 0 · RTX 3060 failed (hevc_nvenc: OpenEncodeSessionEx failed: unsupported device (2)); trying another GPU',
      ]);
    });

    it('an auto job whose QSV encode fails on the Intel slot goes back to the queue for GPU 0, no software retry', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const id = await started(hevc('auto'), true);
      expect(spawner.calls[0]?.args).toContain('hevc_qsv');
      await fails(QSV_FAILED);
      await until('second spawn', () => spawner.calls.length === 2);
      expect(row(id)).toMatchObject({ attempt: 1, failedGpus: ['intel:0000:07:00.0'] });
      const args = spawner.calls[1]?.args.join(' ') ?? '';
      expect(args).toMatch(/-c:0 hevc_nvenc .*-gpu:0 0/);
      expect(args).not.toContain('libx265');
      await spawner.complete({ bytes: 600 });
      expect((await settled(id)).state).toBe('done');
    });

    it('a job that failed on GPU 0 and then on the Intel slot has no GPU left: software, as today, and records no GPU', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const id = await started(hevc('auto'));
      await fails(NVENC_FAILED);
      await until('Intel spawn', () => spawner.calls.length === 2);
      await until('encodedOn', () => row(id).encodedOn === 'Intel Arc A310 · 07:00.0');
      await fails(QSV_FAILED);
      await until('software spawn', () => spawner.calls.length === 3);
      expect(spawner.calls[2]?.args).toContain('libx265');
      await spawner.complete({ bytes: 600 });
      expect((await settled(id)).state).toBe('done');
      expect(row(id)).toMatchObject({
        attempt: 1,
        encodedOn: null,
        failedGpus: ['nvidia:0'],
      });
      expect(planNote(id)).toContain('libx265');
      expect(warnings(id)).toEqual([
        'GPU 0 · RTX 3060 failed (hevc_nvenc: OpenEncodeSessionEx failed: unsupported device (2)); trying another GPU',
        'the GPU encode failed (hevc_qsv: Error initializing an MFX session: -9.); encoded in software instead',
      ]);
    });

    it('after a restart, a job requeued from a failed GPU still carries its warning (from the row reason)', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      outputProbe = probeOf(
        [
          { type: 'video', codec: 'hevc', default: true },
          { type: 'audio', codec: 'aac', language: 'eng', default: true },
        ],
        { sizeBytes: 600 },
      );
      const id = await queue(file(), hevc('auto'));
      // As the requeue left it before the restart: the warnings map of the old process is gone.
      const reason = 'GPU 0 · RTX 3060 failed (hevc_nvenc: x); trying another GPU';
      updateJob(t.db, id, { failedGpus: ['nvidia:0'], reason }, t.clock.now());
      await t.deps.engine.start();
      await until('spawn', () => spawner.calls.length === 1);
      expect(spawner.calls[0]?.args).toContain('hevc_qsv');
      await spawner.complete({ bytes: 600 });
      expect((await settled(id)).state).toBe('done');
      expect(warnings(id)).toEqual([reason]);
    });

    it('a workflow that names hevc_nvenc and fails on the only NVIDIA GPU goes to software in place, never to the Intel slot', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const id = await started(hevc('hevc_nvenc'));
      await fails(NVENC_FAILED);
      await until('software spawn', () => spawner.calls.length === 2);
      expect(spawner.calls[1]?.args).toContain('libx265');
      await spawner.complete({ bytes: 600 });
      expect((await settled(id)).state).toBe('done');
      expect(row(id).failedGpus).toEqual([]);
      expect(warnings(id)).toEqual([
        'the GPU encode failed (hevc_nvenc: OpenEncodeSessionEx failed: unsupported device (2)); encoded in software instead',
      ]);
    });

    it('the same job on gpu:0 encodes with NVENC on GPU 0', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const { args, encodedOn } = await encode(hevc('auto'), false);
      expect(args).toMatch(/-c:0 hevc_nvenc .*-gpu:0 0/);
      expect(args).not.toContain('-init_hw_device');
      expect(encodedOn).toBe('GPU 0 · RTX 3060');
    });

    it('the plain Encode slot (no device) records no GPU', async () => {
      await setup({ capabilities: { ...caps, hwaccels: ['cuda'] } });
      const { args, encodedOn } = await encode(flow('h264', 'auto'), false, 'h264');
      expect(args).toContain('-c:0 h264_nvenc');
      expect(t.deps.engine.scheduler.status().encodeSlots.map((s) => s.id)).toEqual(['encode']);
      expect(encodedOn).toBeNull();
    });

    it.each([
      ['intel:0000:07:00.0', '-c:0 hevc_qsv', 'Intel Arc A310 · 07:00.0'],
      ['nvidia:0', '-c:0 hevc_nvenc', 'GPU 0 · RTX 3060'],
    ])('pinned to %s, the one Encode slot records the GPU by name', async (device, codec, name) => {
      await setup({ capabilities: mixed(['cuda']) });
      setSetting(t.db, 'engine.encodeDevice', device, t.clock.now());
      const { args, encodedOn } = await encode(hevc('auto'), false);
      expect(args).toContain(codec);
      expect(t.deps.engine.scheduler.status().encodeSlots).toEqual([
        { id: 'encode', label: 'Encode', jobId: null },
      ]);
      expect(encodedOn).toBe(name);
    });

    it('a workflow that names hevc_nvenc takes the NVIDIA GPU and is not retargeted, even with Intel first', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const { args } = await encode(hevc('hevc_nvenc'), true);
      expect(args).toContain('-c:0 hevc_nvenc');
      expect(args).not.toContain('hevc_qsv');
    });

    it('a workflow that names hevc_nvenc prepares with fit nvidia and takes the NVIDIA slot, even with Intel first', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const prepare = vi.spyOn(t.deps.engine.pipeline, 'prepare');
      const { args, encodedOn } = await encode(hevc('hevc_nvenc'), true);
      await expect(prepare.mock.results[0]?.value).resolves.toEqual({
        lane: 'encode',
        fit: 'nvidia',
      });
      expect(args).toMatch(/-c:0 hevc_nvenc .*-gpu:0 0/);
      expect(encodedOn).toBe('GPU 0 · RTX 3060');
    });

    it.each([
      ['auto', 'gpu'],
      ['libx265', 'software'],
    ])('a %s job prepares with fit %s', async (encoder, fit) => {
      await setup({ capabilities: mixed(['cuda']) });
      const prepare = vi.spyOn(t.deps.engine.pipeline, 'prepare');
      await encode(hevc(encoder), false);
      await expect(prepare.mock.results[0]?.value).resolves.toEqual({ lane: 'encode', fit });
    });

    it('without the CUDA hwaccel an auto QSV job on gpu:0 encodes as built', async () => {
      await setup({ capabilities: mixed([]) });
      const { args, encodedOn } = await encode(hevc('auto'), false);
      expect(args).toContain('-c:0 hevc_qsv');
      expect(args).not.toContain('nvenc');
      // QSV in the NVIDIA slot does not encode on that GPU.
      expect(encodedOn).toBeNull();
    });
  });

  it('dry run: Remove duplicate audio after Encode audio drops the copy made from the lesser source, and the plan says why', async () => {
    sourceProbe = probeOf(
      [
        { type: 'video', codec: 'hevc', default: true },
        { type: 'audio', codec: 'truehd', language: 'eng', default: true },
        { type: 'audio', codec: 'ac3', language: 'eng' },
      ],
      { sizeBytes: 1000 },
    );
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        node('ea', 'core:encode-audio', { mode: 'reencode', downmixTo: 'stereo' }),
        node('dd', 'core:remove-duplicate-audio'),
        node('ro', 'core:replace-original'),
      ),
    );
    const id = await queue(file(), wf, { dryRun: true });
    await t.deps.engine.start();
    expect((await settled(id)).state).toBe('dry_run');
    expect(listTrace(t.db, id).find((e) => e.nodeId === 'dd')?.reason).toBe(
      'dropped audio #2: same as audio #1 (AAC 2.0 English)',
    );
    const result = findJobResult(t.db, id);
    expect(result?.plan?.streams.map((s) => [s.index, s.action, s.default.after, s.note])).toEqual([
      [0, 'keep', true, ''],
      [1, 'convert', true, 'convert truehd→aac (aac 160k 2ch)'],
      [2, 'drop', false, 'same as audio #1 (AAC 2.0 English)'],
    ]);
    const maps = (result?.command ?? '').match(/-map \S+/g);
    expect(maps).toEqual(['-map 0:0', '-map 0:1']);
  });

  it('full run: queued→probing→deciding→building→encoding→verifying→replacing→done; before/after bytes; recycle has the original; trace complete', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    expect(row(id).state).toBe('queued');
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    expect(spawner.calls[0]?.args.slice(0, 2)).toEqual(['-loglevel', 'level+warning']);
    expect(spawner.calls[0]?.logPath).toBe(join(configDir, 'logs', 'jobs', `${id}.attempt-1.log`));
    expect(row(id)).toMatchObject({ state: 'encoding', lane: 'encode' });
    spawner.emitProgress({ outTimeSeconds: 30, speed: 2, fps: 50, sizeBytes: 300 });
    expect(row(id).progress).toMatchObject({ percent: 50, etaSeconds: 15 });
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'done', reason: null, lane: null, progress: null });
    expect(states(id)).toEqual([
      'probing',
      'deciding',
      'building',
      'encoding',
      'verifying',
      'replacing',
      'done',
    ]);
    expect(findJobResult(t.db, id)).toMatchObject({
      outcome: 'done',
      beforeBytes: 1000,
      afterBytes: 600,
      replacedTo: 'recycle',
      plan: { rewrite: true },
    });
    expect((await stat(file())).size).toBe(600);
    expect((await stat(join(root, '.transcoda-recycle', 'Show', 'a.mkv'))).size).toBe(1000);
    const trace = listTrace(t.db, id);
    expect(trace.map((e) => [e.nodeId, e.phase])).toEqual([
      ['in', 'pass'],
      ['ev', 'build'],
      ['ro', 'finish'],
    ]);
    expect(trace.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(job.walkPath).toEqual([
      { workflowPath: [], nodeId: 'in', port: 'file' },
      { workflowPath: [], nodeId: 'ev', port: 'file' },
      { workflowPath: [], nodeId: 'ro', port: 'file' },
    ]);
    // The probe was written to the file row; temp removed.
    expect(t.deps.engine.jobDetail(id)?.probe).toMatchObject({ container: 'mkv' });
    expect(await listAll(transcodeDir)).toEqual([]);
    const changed = published.filter((e) => e.type === 'job.changed' && e.jobId === id);
    expect(changed.some((e) => e.type === 'job.changed' && e.currentNode?.nodeId === 'ro')).toBe(
      true,
    );
  });

  it('size gate below threshold → kept_original and the temp output removed', async () => {
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        toH264(),
        node('sg', 'core:size-gate', { minSavingPercent: 50 }),
        node('ro', 'core:replace-original'),
      ),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 900 });
    expect(await settled(id)).toMatchObject({
      state: 'kept_original',
      reason: 'saved only 10.0%, below 50%',
    });
    expect(findJobResult(t.db, id)).toMatchObject({ afterBytes: 900, replacedTo: null });
    expect(await listAll(transcodeDir)).toEqual([]);
    expect((await stat(file())).size).toBe(1000);
  });

  it('verify failure → attempt 2 → failed on the second failure; original untouched', async () => {
    brokenOutput = true;
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    expect(row(id)).toMatchObject({ attempt: 2 });
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', attempt: 2 });
    expect(job.reason).toMatch(/^verify: duration: output #0 \(video #0\) ends early/);
    expect(states(id)).toContain('queued');
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(join(root))).toEqual(['/Show', '/Show/a.mkv']);
    // Trace entries keep their attempt; seq continues across attempts.
    const trace = listTrace(t.db, id);
    expect(trace.map((e) => [e.attempt, e.seq])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 4],
      [2, 5],
      [2, 6],
    ]);
  });

  it('fingerprint change before replace → requeued once, then failed "file changed during processing"', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    const touch = async (n: number) => {
      const when = new Date(Date.now() - n * 60_000);
      await utimes(file(), when, when);
    };
    await until('first spawn', () => spawner.calls.length === 1);
    await touch(10);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    expect(row(id)).toMatchObject({ requeues: 1, attempt: 1 });
    await touch(20);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({
      state: 'failed',
      reason: 'file changed during processing',
    });
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(transcodeDir)).toEqual([]);
  });

  it('cancel during encoding → cancelled, temp removed; cancel during replacing → done with reason "cancelled too late"', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    expect(t.deps.engine.scheduler.cancelJob(id)).toBe('ok');
    expect(await settled(id)).toMatchObject({ state: 'cancelled' });
    expect(spawner.signals).toEqual(['SIGKILL']);
    expect(await listAll(transcodeDir)).toEqual([]);
    expect(findJobResult(t.db, id)?.outcome).toBe('cancelled');

    // Cancelled while the replacement is being written beside the original: too late.
    await t.deps.engine.stop();
    let cancelId = '';
    await setup({
      fs: {
        ...fsOps,
        copyFile: async (src, dst) => {
          if (dst.endsWith('.tmp')) t.deps.engine.scheduler.cancelJob(cancelId);
          return nodeFsOps.copyFile(src, dst);
        },
      },
    });
    const wf2 = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    cancelId = await queue(join(root, 'Show', 'b.mkv'), wf2);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(cancelId)).toMatchObject({
      state: 'done',
      reason: 'cancelled too late',
    });
    expect((await stat(join(root, 'Show', 'b.mkv'))).size).toBe(600);
  });

  it('shutdown during encoding → process killed, no job update, temp dir left in place; a following engine.start() sweeps it: requeued once', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    const before = row(id);
    await t.deps.engine.stop();
    expect(spawner.signals).toEqual(['SIGKILL']);
    expect(row(id)).toEqual(before);
    expect(row(id).state).toBe('encoding');
    expect(await listAll(transcodeDir)).toEqual([`/${id}`]);

    // A restart over the same database: the sweep requeues it once; the queue stays paused.
    t.db
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('queue.paused', 'true', '')")
      .run();
    const db = t.db;
    const app2 = createTestApp({
      db,
      config: { configDir, transcodeDir },
      capabilities: caps,
      spawner: new TestSpawner(),
      fsOps,
      exec: fakeExec,
    });
    const sweep = await app2.deps.engine.start();
    try {
      expect(sweep.interrupted).toEqual([id]);
      expect(findJob(db, id)).toMatchObject({
        state: 'queued',
        requeues: 1,
        reason: 'interrupted',
      });
      expect(await listAll(transcodeDir)).toEqual([]);
    } finally {
      await app2.deps.engine.stop();
    }
  });

  /** v2 (active) ends nothing_to_do; the v3 it gets saved as ends kept_original. */
  const savedV3 = (wf: string): void => {
    const saved = t.deps.workflows.save(
      {
        id: wf,
        baseVersion: 2,
        graph: line(
          node('in', 'core:input-manual'),
          toH264(),
          node('sg', 'core:size-gate', { minSavingPercent: 10 }),
        ),
      },
      'u',
    );
    expect(saved.version).toBe(3);
  };
  const v2Workflow = (): string =>
    workflow(line(node('in', 'core:input-manual'), node('ro', 'core:replace-original')));
  /** job.changed events of the job published while it was probing. */
  const probingEvents = (id: string): number =>
    published.filter((e) => e.type === 'job.changed' && e.jobId === id && e.state === 'probing')
      .length;

  /** A final real result of version `version` for the file (as a finished earlier job). */
  async function priorDone(wf: string, runOf: string, version: number): Promise<void> {
    const prior = insertJob(
      t.db,
      {
        id: `prior-${version}`,
        runId: row(runOf).runId,
        libraryId: lib.id,
        fileId: null,
        path: '/elsewhere.mkv',
        workflowId: wf,
        workflowVersion: version,
        dryRun: false,
        testEncode: false,
        state: 'done',
        priority: 0,
      },
      t.clock.now(),
    );
    insertJobResult(t.db, {
      jobId: prior.id,
      fingerprint: fingerprintKey(await fingerprintOf(file())),
      workflowId: wf,
      workflowVersion: version,
      outcome: 'done',
      beforeBytes: 1000,
      afterBytes: 600,
      estimatedBytes: null,
      command: null,
      plan: null,
      replacedTo: 'recycle',
      logPath: null,
      warnings: [],
      problems: [],
      outputProbe: null,
      createdAt: '2026-10-01T10:00:00.000Z',
    });
  }

  it('a real job queued under v2 that starts after v3 was activated runs v3 and its result says v3', async () => {
    const wf = v2Workflow();
    const id = await queue(file(), wf);
    expect(row(id).workflowVersion).toBe(2);
    savedV3(wf);
    expect(t.deps.workflows.activate(wf, 3, 'u').kind).toBe('ok');
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'kept_original', workflowVersion: 3 });
    expect(findJobResult(t.db, id)).toMatchObject({ outcome: 'kept_original', workflowVersion: 3 });
    expect(listTrace(t.db, id).map((e) => e.nodeId)).toEqual(['in', 'ev', 'sg']);
    // The re-pin was published before the file was probed.
    expect(probingEvents(id)).toBeGreaterThanOrEqual(2);
  });

  it('the same file with a final real v3 result ends already_processed and its result row carries v3', async () => {
    const wf = v2Workflow();
    const id = await queue(file(), wf);
    savedV3(wf);
    expect(t.deps.workflows.activate(wf, 3, 'u').kind).toBe('ok');
    await priorDone(wf, id, 3);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({
      state: 'already_processed',
      reason:
        'already done on 2026-10-01T10:00:00.000Z; this file is the original from before then (moved back from the recycle folder?); run with force to process it again',
      workflowVersion: 3,
    });
    expect(findJobResult(t.db, id)).toMatchObject({
      outcome: 'already_processed',
      workflowVersion: 3,
    });
    expect(spawner.calls).toEqual([]);
  });

  it("a forced run's re-pinned job ignores the v3 history and runs", async () => {
    const wf = v2Workflow();
    const id = await queue(file(), wf, { force: true });
    savedV3(wf);
    expect(t.deps.workflows.activate(wf, 3, 'u').kind).toBe('ok');
    await priorDone(wf, id, 3);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'kept_original', workflowVersion: 3 });
  });

  it('a dry-run job keeps its version after another is activated; a real job on the active version is not re-pinned', async () => {
    const wf = v2Workflow();
    const dry = await queue(file(), wf, { dryRun: true });
    expect(row(dry).workflowVersion).toBe(2);
    savedV3(wf);
    expect(t.deps.workflows.activate(wf, 3, 'u').kind).toBe('ok');
    const real = await queue(file(), wf);
    expect(row(real).workflowVersion).toBe(3);
    await t.deps.engine.start();
    expect(await settled(dry)).toMatchObject({ state: 'nothing_to_do', workflowVersion: 2 });
    expect(await settled(real)).toMatchObject({ state: 'kept_original', workflowVersion: 3 });
    expect(probingEvents(dry)).toBe(1);
    expect(probingEvents(real)).toBe(1);
  });

  it('activating another version during a v2 encode does not re-pin the running job', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    t.deps.workflows.save(
      {
        id: wf,
        baseVersion: 2,
        graph: line(node('in', 'core:input-manual'), node('ro', 'core:replace-original')),
      },
      'u',
    );
    expect(t.deps.workflows.activate(wf, 3, 'u').kind).toBe('ok');
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done', workflowVersion: 2 });
    expect(findJobResult(t.db, id)?.workflowVersion).toBe(2);
  });

  it('workflow invalid at job start → failed "workflow invalid"; deactivated before start → skipped "workflow is not active"', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    // The pinned version breaks before the job starts (an unknown node type).
    const stored = t.db
      .prepare('SELECT graph FROM workflow_versions WHERE workflow_id = ? AND version = 2')
      .get(wf) as { graph: string };
    const graph = JSON.parse(stored.graph) as WorkflowGraph;
    graph.nodes.push(node('ghost', 'test:no-such-node'));
    t.db
      .prepare('UPDATE workflow_versions SET graph = ? WHERE workflow_id = ? AND version = 2')
      .run(JSON.stringify(graph), wf);
    await t.deps.engine.start();
    const job = await settled(id);
    expect(job.state).toBe('failed');
    expect(job.reason).toMatch(/^workflow invalid: \d+ error\(s\)$/);
    expect(job.attempt).toBe(1);
    expect(spawner.calls).toEqual([]);

    const wf2 = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    t.deps.engine.scheduler.pauseQueue();
    const id2 = await queue(file(), wf2);
    expect(row(id2).dryRun).toBe(false);
    expect(t.deps.workflows.deactivate(wf2).kind).toBe('ok');
    t.deps.engine.scheduler.resumeQueue();
    expect(await settled(id2)).toMatchObject({
      state: 'skipped',
      reason: 'workflow is not active',
    });
    expect(spawner.calls).toEqual([]);
  });

  it('lane: video convert → encode; audio-only convert or remux → quick', () => {
    const probe = probeOf([{ type: 'video', codec: 'h264' }, { type: 'audio' }]);
    const model = modelFromProbe(probe);
    expect(laneFor(withStream(model, 0, { mode: 'convert', codec: 'hevc' }), probe)).toBe('encode');
    expect(laneFor(withStream(model, 1, { mode: 'convert', codec: 'aac' }), probe)).toBe('quick');
    expect(laneFor({ ...model, container: 'mp4' }, probe)).toBe('quick');
    // A cover is never encoded.
    const covered = probeOf([{ type: 'video', attachedPic: true, codec: 'png' }]);
    expect(laneFor(withStream(modelFromProbe(covered), 0, { mode: 'convert' }), covered)).toBe(
      'quick',
    );
  });

  it('notify failure is a warning, not a failure (and the URL is never stored)', async () => {
    const url = `https://hooks.example.com/notify/${SECRET}?key=${SECRET}`;
    const fetchMock = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        toH264(),
        node('ro', 'core:replace-original'),
        node('nw', 'core:notify-webhook', { url, method: 'POST' }),
      ),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body).toMatchObject({ jobId: id, outcome: 'done', beforeBytes: 1000, afterBytes: 600 });
    expect(findJobResult(t.db, id)?.warnings).toEqual([
      'notify https://hooks.example.com/… failed: fetch failed for https://hooks.example.com/…',
    ]);
    const stored = JSON.stringify([
      t.db.prepare('SELECT * FROM jobs').all(),
      t.db.prepare('SELECT * FROM job_results').all(),
      t.db.prepare('SELECT * FROM job_trace').all(),
      published,
    ]);
    expect(stored).not.toContain(SECRET);
    vi.unstubAllGlobals();
  });
});

describe('pipeline: size gate pass and else', () => {
  const PASS_URL = 'https://hooks.example.com/pass';
  const ELSE_URL = 'https://hooks.example.com/else';
  const hook = (id: string, url: string) =>
    node(id, 'core:notify-webhook', { url, method: 'POST' });
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const calledUrls = () => fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
  const body = (i: number) =>
    JSON.parse(String((fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].body));
  const traceOf = (id: string, nodeId: string) =>
    listTrace(t.db, id)
      .filter((e) => e.nodeId === nodeId)
      .map((e) => [e.phase, e.port, e.reason]);

  it('else path: a failing gate keeps the original, runs only the else notify and records the branch', async () => {
    const wf = workflow(
      gated(
        50,
        [node('ro', 'core:replace-original'), hook('pn', PASS_URL)],
        [hook('en', ELSE_URL)],
      ),
    );
    const id = await queue(file(), wf);
    const job = await runOnce(id, 900);
    expect(job).toMatchObject({ state: 'kept_original', reason: 'saved only 10.0%, below 50%' });
    expect(calledUrls()).toEqual([ELSE_URL]);
    expect(body(0)).toMatchObject({
      jobId: id,
      outcome: 'kept_original',
      beforeBytes: 1000,
      afterBytes: 900,
      replacedTo: null,
      reason: 'saved only 10.0%, below 50%',
    });
    expect(findJobResult(t.db, id)).toMatchObject({
      outcome: 'kept_original',
      afterBytes: 900,
      replacedTo: null,
    });
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(transcodeDir)).toEqual([]);
    // The trace says which branch the gate took, and the walk now runs through else.
    expect(traceOf(id, 'sg').at(-1)).toEqual([
      'finish',
      'else',
      'Size gate: saved 10.0%, below 50% \u2192 no',
    ]);
    // Its numbers are findings too, so the job page need not read them from the reason.
    expect(
      listTrace(t.db, id)
        .filter((e) => e.nodeId === 'sg')
        .at(-1)?.findings,
    ).toEqual({
      minSavingPercent: 50,
      savedPercent: 10,
    });
    expect(t.deps.engine.jobDetail(id)?.path).toEqual([
      { workflowPath: [], nodeId: 'in', port: 'file' },
      { workflowPath: [], nodeId: 'ev', port: 'file' },
      { workflowPath: [], nodeId: 'sg', port: 'else' },
      { workflowPath: [], nodeId: 'en', port: 'file' },
    ]);
  });

  it('pass path: the pass steps run, the else notify does not, and the trace says pass', async () => {
    const wf = workflow(
      gated(
        50,
        [node('ro', 'core:replace-original'), hook('pn', PASS_URL)],
        [hook('en', ELSE_URL)],
      ),
    );
    const id = await queue(file(), wf);
    const job = await runOnce(id, 400);
    expect(job).toMatchObject({ state: 'done' });
    expect(calledUrls()).toEqual([PASS_URL]);
    expect(body(0)).toMatchObject({ outcome: 'done', afterBytes: 400 });
    expect((await stat(file())).size).toBe(400);
    expect(traceOf(id, 'sg').at(-1)).toEqual([
      'finish',
      'pass',
      'Size gate: saved 60.0%, at least 50% \u2192 yes',
    ]);
    expect(
      listTrace(t.db, id)
        .filter((e) => e.nodeId === 'sg')
        .at(-1)?.findings,
    ).toEqual({
      minSavingPercent: 50,
      savedPercent: 60,
    });
    expect(t.deps.engine.jobDetail(id)?.path.map((s) => s.nodeId)).toEqual([
      'in',
      'ev',
      'sg',
      'ro',
      'pn',
    ]);
  });

  it('a failing gate with nothing wired to else is kept_original as before, with no notification', async () => {
    const wf = workflow(gated(50, [node('ro', 'core:replace-original'), hook('pn', PASS_URL)], []));
    const id = await queue(file(), wf);
    expect(await runOnce(id, 900)).toMatchObject({
      state: 'kept_original',
      reason: 'saved only 10.0%, below 50%',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an active workflow stored with the v1 gate (one output) still runs, on pass and on kept_original', async () => {
    const v1 = (): WorkflowGraph =>
      mainGraph(
        [
          node('in', 'core:input-manual'),
          toH264(),
          node('sg', 'core:size-gate', { minSavingPercent: 50 }, { typeVersion: 1 }),
          node('ro', 'core:replace-original'),
        ],
        [edge('in', 'ev'), edge('ev', 'sg'), edge('sg', 'ro')],
      );
    const kept = await queue(file(), workflow(v1()));
    expect(await runOnce(kept, 900)).toMatchObject({
      state: 'kept_original',
      reason: 'saved only 10.0%, below 50%',
    });
    const replaced = await queue(file(), workflow(v1()), { force: true });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 400 });
    expect(await settled(replaced)).toMatchObject({ state: 'done' });
    expect((await stat(file())).size).toBe(400);
  });

  it('job detail returns a v1-stored gate workflow with its edges on pass', async () => {
    const wf = workflow(
      mainGraph(
        [
          node('in', 'core:input-manual'),
          toH264(),
          node('sg', 'core:size-gate', { minSavingPercent: 50 }, { typeVersion: 1 }),
          node('ro', 'core:replace-original'),
        ],
        [edge('in', 'ev'), edge('ev', 'sg'), edge('sg', 'ro')],
      ),
    );
    const id = await queue(file(), wf);
    await runOnce(id, 400);
    const g = t.deps.engine.jobDetail(id)?.graph;
    expect(g?.edges.map((e) => `${e.from.node}.${e.from.port}`)).toEqual([
      'in.file',
      'ev.file',
      'sg.pass',
    ]);
    expect(g?.nodes.find((n) => n.id === 'sg')?.typeVersion).toBe(2);
  });

  it('an else notify that fails is a warning on the kept_original job', async () => {
    fetchMock.mockImplementation(async () => new Response('no', { status: 500 }));
    const wf = workflow(gated(50, [node('ro', 'core:replace-original')], [hook('en', ELSE_URL)]));
    const id = await queue(file(), wf);
    await runOnce(id, 900);
    expect(row(id).state).toBe('kept_original');
    expect(findJobResult(t.db, id)?.warnings).toEqual([
      'notify https://hooks.example.com/\u2026 answered 500',
    ]);
  });

  it('dry run: both branches are possible; the walk lists the else steps and the gate says it depends', async () => {
    const wf = workflow(gated(50, [node('ro', 'core:replace-original')], [hook('en', ELSE_URL)]));
    const id = await queue(file(), wf, { dryRun: true });
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'dry_run' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.deps.engine.jobDetail(id)?.path.map((s) => s.nodeId)).toEqual([
      'in',
      'ev',
      'sg',
      'ro',
      'en',
    ]);
    // The gate's step leaves by no port: the result decides.
    expect(t.deps.engine.jobDetail(id)?.path.find((s) => s.nodeId === 'sg')?.port).toBeNull();
    expect(traceOf(id, 'sg').at(-1)).toEqual([
      'finish',
      null,
      'Size gate: decides after encoding: keep if it saves less than 50%',
    ]);
    expect(
      listTrace(t.db, id)
        .filter((e) => e.nodeId === 'sg')
        .at(-1)?.findings,
    ).toEqual({
      minSavingPercent: 50,
    });
  });
});

describe('pipeline: plan-only dry run outcome and the size gate (#41)', () => {
  const traceOf = (id: string, nodeId: string) =>
    listTrace(t.db, id)
      .filter((e) => e.nodeId === nodeId)
      .map((e) => [e.phase, e.port, e.reason]);
  const planOfJob = (id: string) => findJobResult(t.db, id)?.plan;
  const dry = async (wf: string): Promise<string> => {
    const id = await queue(file(), wf, { dryRun: true, testEncode: false });
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'dry_run' });
    return id;
  };

  it('no gate: would replace (nothing depends on size)', async () => {
    const id = await dry(
      workflow(
        line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
      ),
    );
    expect(planOfJob(id)?.dependsOnSize).toBeUndefined();
    expect(t.deps.engine.listJobs({ dependsOnSize: true }).jobs).toEqual([]);
  });

  it('a gate between the encode and the write: depends on size, carrying its threshold', async () => {
    const wf = workflow(gated(25, [node('ro', 'core:replace-original')], []));
    const id = await dry(wf);
    expect(planOfJob(id)?.dependsOnSize).toEqual({ minSavingPercent: 25 });
    const listed = t.deps.engine.listJobs({});
    expect(listed.jobs.find((j) => j.id === id)?.dependsOnSize).toEqual({ minSavingPercent: 25 });
    expect(listed.dependsOnSizeCount).toBe(1);
    expect(t.deps.engine.listJobs({ dependsOnSize: true }).jobs.map((j) => j.id)).toEqual([id]);
    const run = t.deps.engine.queue.runSummary(row(id).runId);
    expect(run?.counts).toMatchObject({ dry_run: 1, dependsOnSize: 1 });
    expect(run?.files[0]?.dependsOnSize).toEqual({ minSavingPercent: 25 });
    expect(traceOf(id, 'sg').at(-1)).toEqual([
      'finish',
      null,
      'Size gate: decides after encoding: keep if it saves less than 25%',
    ]);
  });

  it('two gates before the write: the strictest threshold decides', async () => {
    const id = await dry(
      workflow(
        line(
          node('in', 'core:input-manual'),
          toH264(),
          node('g1', 'core:size-gate', { minSavingPercent: 10 }),
          node('g2', 'core:size-gate', { minSavingPercent: 30 }),
          node('ro', 'core:replace-original'),
        ),
      ),
    );
    expect(planOfJob(id)?.dependsOnSize).toEqual({ minSavingPercent: 30 });
  });

  it('a Run node that encodes in its sub-workflow, then a gate before the replace: depends on size', async () => {
    // A sub-workflow holds no finish node (validate refuses one), so the gate after the Run node is
    // the one between the encode and the write.
    const sub = t.deps.workflows.create({ name: 'Encode sub', kind: 'subworkflow' }, 'u');
    t.deps.workflows.save(
      {
        id: sub.id,
        baseVersion: 1,
        graph: chain(
          'subworkflow',
          node('sev', 'core:encode-video', { codec: 'h264', encoder: 'libx264', skipIf: 'never' }),
        ),
      },
      'u',
    );
    const id = await dry(
      workflow(
        line(
          node('in', 'core:input-manual'),
          node('run', 'core:run-subworkflow', { subworkflowId: sub.id, version: 2, overrides: {} }),
          node('sg', 'core:size-gate', { minSavingPercent: 15 }),
          node('ro', 'core:replace-original'),
        ),
      ),
    );
    expect(planOfJob(id)?.streams[0]).toMatchObject({ action: 'convert' });
    expect(planOfJob(id)?.dependsOnSize).toEqual({ minSavingPercent: 15 });
  });

  it('a gate on the branch the file did not take does not count', async () => {
    const wf = workflow(
      mainGraph(
        [
          node('in', 'core:input-manual'),
          node('vi', 'core:video-is', { codecs: ['hevc'] }),
          toH264(),
          node('ro', 'core:replace-original'),
          node('ev2', 'core:encode-video', { codec: 'h264', encoder: 'libx264', skipIf: 'never' }),
          node('sg', 'core:size-gate', { minSavingPercent: 40 }),
          node('ro2', 'core:replace-original'),
        ],
        [
          edge('in', 'vi'),
          edge('vi', 'ev', { from: 'pass' }),
          edge('ev', 'ro'),
          edge('vi', 'ev2', { from: 'else' }),
          edge('ev2', 'sg'),
          edge('sg', 'ro2', { from: 'pass' }),
        ],
      ),
    );
    const id = await dry(wf);
    expect(t.deps.engine.jobDetail(id)?.path.map((s) => s.nodeId)).not.toContain('sg');
    expect(planOfJob(id)?.dependsOnSize).toBeUndefined();
  });

  it('a bypassed gate does not count', async () => {
    const id = await dry(
      workflow(
        line(
          node('in', 'core:input-manual'),
          toH264(),
          node('sg', 'core:size-gate', { minSavingPercent: 40 }, { bypassed: true }),
          node('ro', 'core:replace-original'),
        ),
      ),
    );
    expect(planOfJob(id)?.dependsOnSize).toBeUndefined();
  });

  it('a test-encode dry run measures instead: it never depends on size', async () => {
    const wf = workflow(gated(25, [node('ro', 'core:replace-original')], []));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(await runOnce(id, 600)).toMatchObject({ state: 'dry_run' });
    expect(planOfJob(id)?.dependsOnSize).toBeUndefined();
  });
});

describe('pipeline: the verified output probe (before/after)', () => {
  const toReplace = () =>
    workflow(line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')));
  const outputOf = (id: string) => findJobResult(t.db, id)?.outputProbe as ProbeResult | null;

  it('a real run keeps the probe verify read of its output with the result; the job detail shows it without the raw JSON', async () => {
    const id = await queue(file(), toReplace());
    expect(await runOnce(id)).toMatchObject({ state: 'done' });
    expect(outputOf(id)).toMatchObject({
      container: 'mkv',
      sizeBytes: 600,
      streams: [
        { index: 0, type: 'video', codec: 'h264' },
        { index: 1, type: 'audio', codec: 'aac' },
      ],
    });
    // Stored without the raw ffprobe JSON (nothing reads it), with each stream's tag bitrate.
    expect(outputOf(id)).not.toHaveProperty('raw');
    expect(outputOf(id)?.streams[0]).toHaveProperty('tagBitrateKbps', null);
    const detail = t.deps.engine.jobDetail(id);
    expect(detail?.outputProbe).toMatchObject({ container: 'mkv', sizeBytes: 600 });
    expect(detail?.outputProbe).not.toHaveProperty('raw');
    expect(detail?.outputProbe?.streams[0]).toMatchObject({ codec: 'h264', tagBitrateKbps: null });
  });

  it('the job detail reads a whole ProbeResult the first builds stored, without its raw JSON', async () => {
    const id = await queue(file(), toReplace());
    expect(await runOnce(id)).toMatchObject({ state: 'done' });
    const legacy = { ...outputProbe, raw: ffprobeJson(outputProbe) };
    t.db
      .prepare('UPDATE job_results SET output_probe = ? WHERE job_id = ?')
      .run(JSON.stringify(legacy), id);
    const detail = t.deps.engine.jobDetail(id);
    expect(detail?.outputProbe).not.toHaveProperty('raw');
    expect(detail?.outputProbe?.streams[0]).toMatchObject({ codec: 'h264', tagBitrateKbps: null });
  });

  it('a test-encode keeps it too', async () => {
    const id = await queue(file(), toReplace(), { dryRun: true, testEncode: true });
    expect(await runOnce(id)).toMatchObject({ state: 'dry_run' });
    expect(outputOf(id)).toMatchObject({ sizeBytes: 600, streams: [{ codec: 'h264' }, {}] });
  });

  it('a size gate that keeps the original keeps the probe of what it measured', async () => {
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        toH264(),
        node('sg', 'core:size-gate', { minSavingPercent: 50 }),
        node('ro', 'core:replace-original'),
      ),
    );
    const id = await queue(file(), wf);
    expect(await runOnce(id, 900)).toMatchObject({ state: 'kept_original' });
    expect(outputOf(id)).toMatchObject({ container: 'mkv', streams: [{ codec: 'h264' }, {}] });
  });

  it('a plan-only dry run has none', async () => {
    const id = await queue(file(), toReplace(), { dryRun: true, testEncode: false });
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'dry_run' });
    expect(outputOf(id)).toBeNull();
    expect(t.deps.engine.jobDetail(id)?.outputProbe).toBeNull();
  });

  it('a job that fails after its output passed verify keeps none: that output was thrown away', async () => {
    const id = await queue(file(), toReplace());
    await t.deps.engine.start();
    const touch = async (n: number) => {
      const when = new Date(Date.now() - n * 60_000);
      await utimes(file(), when, when);
    };
    await until('first spawn', () => spawner.calls.length === 1);
    await touch(10);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    await touch(20);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'failed' });
    expect(outputOf(id)).toBeNull();
  });

  it('a job whose output failed verify has none', async () => {
    brokenOutput = true;
    const id = await queue(file(), toReplace());
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'failed' });
    expect(outputOf(id)).toBeNull();
  });
});

describe('pipeline: controller notes', () => {
  it('a folder swapped for a symlink out of the root between queue and start → skipped, nothing written outside', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    const away = join(base, 'outside', 'Show');
    await rename(join(root, 'Show'), away);
    await symlink(away, join(root, 'Show'));
    const outsideBefore = await listAll(join(base, 'outside'));
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'skipped', reason: 'symlink escapes root' });
    expect(spawner.calls).toEqual([]);
    expect(await listAll(join(base, 'outside'))).toEqual(outsideBefore);
    expect(await listAll(transcodeDir)).toEqual([]);
  });

  it('a library removed between queue and start → skipped "outside library root"', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    // Soft-delete directly (deleteLibrary refuses while a job is queued).
    t.db.prepare('UPDATE libraries SET deleted_at = ? WHERE id = ?').run('2026-01-01', lib.id);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'skipped', reason: 'outside library root' });
    expect(spawner.calls).toEqual([]);
  });

  it('a file still growing at job start is skipped "still growing" (no immediate requeue)', async () => {
    await t.deps.engine.stop();
    await setup({ settleMinutes: 3 });
    // Times relative to the test clock.
    const hourAgo = new Date(t.clock.now().getTime() - 60 * 60 * 1000);
    await utimes(file(), hourAgo, hourAgo);
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    const fresh = t.clock.now();
    await utimes(file(), fresh, fresh);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({
      state: 'skipped',
      reason: 'still growing',
      requeues: 0,
    });
    expect(states(id)).toEqual(['probing', 'skipped']);
    expect(spawner.calls).toEqual([]);
  });

  it('a source decoder error mid-encode that the source reproduces at that spot → kept_original, no retry', async () => {
    sourceSpotsDamaged = true;
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({
      bytes: 600,
      at: 30,
      stderr: [
        '[hevc @ 0x1234] [error] Could not find ref with POC 3',
        '[libx264 @ 0x9] [warning] x',
      ],
    });
    expect(await settled(id)).toMatchObject({
      state: 'kept_original',
      reason: 'source has decode errors; nothing was replaced',
      attempt: 1,
    });
    expect(findJobResult(t.db, id)?.warnings).toEqual([
      '[hevc @ 0x1234] [error] Could not find ref with POC 3',
      expect.stringMatching(
        /^decode-sample: source: decoding 7 s from 29\.00s failed: \[h264 @ 0x1\] error while decoding/,
      ),
    ]);
    // The confirming decode read the source around the spot (from a second before it).
    const spot = execCalls.find(
      (c) => c[0] === 'ffmpeg' && c.includes('-ss') && c.join(' ').includes(` -i ${root}`),
    );
    expect(spot?.[spot.indexOf('-ss') + 1]).toBe('29.000');
    expect(spawner.calls).toHaveLength(1);
    expect((await stat(file())).size).toBe(1000);
  });

  it('a source decoder error mid-encode the source does not reproduce is output-invalid: retried once, then failed', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    const stderr = ['[hevc @ 0x1234] [error] Could not find ref with POC 3'];
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600, stderr });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600, stderr });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', attempt: 2 });
    expect(job.reason).toMatch(
      /^encode reported source decode errors the source does not reproduce: \[hevc/,
    );
  });

  it('decoder errors before the first output frame (a stream cut mid-GOP) are ignored', async () => {
    sourceSpotsDamaged = true;
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({
      bytes: 600,
      leading: [
        '[hevc @ 0x1] [error] Could not find ref with POC 21',
        '[vist#0:0/hevc @ 0x2] [dec:hevc @ 0x3] [error] Error submitting packet to decoder',
      ],
    });
    expect(await settled(id)).toMatchObject({ state: 'done', reason: null });
    expect(findJobResult(t.db, id)?.warnings).toEqual([
      'ignored 2 decoder error(s) before the first output frame',
    ]);
  });

  it('an error from the output side during the encode is retried, then fails', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    const stderr = [
      '[out#0/matroska @ 0x1] [error] Error writing trailer: No space left on device',
    ];
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600, stderr });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600, stderr });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', attempt: 2 });
    expect(job.reason).toMatch(/^encode reported errors: \[out#0/);
  });

  it('a non-zero ffmpeg exit fails with the log tail as the reason', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    const stderr = [...Array.from({ length: 5000 }, () => 'noise'), '[error] Conversion failed!'];
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 0, stderr, code: 1 });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 0, stderr, code: 1 });
    expect(await settled(id)).toMatchObject({
      state: 'failed',
      reason: 'ffmpeg exited 1: Conversion failed!',
    });
    // jobLog serves only the tail.
    const tail = await t.deps.engine.jobLog(id);
    expect(tail?.length).toBeLessThanOrEqual(64 * 1024);
    expect(tail?.endsWith('[error] Conversion failed!\n')).toBe(true);
  });

  it('a GPU encode that fails runs once more on the software encoder, and says so', async () => {
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        node('ev', 'core:encode-video', { codec: 'h264', encoder: 'h264_nvenc', skipIf: 'never' }),
        node('ro', 'core:replace-original'),
      ),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    expect(spawner.calls[0]?.args).toContain('h264_nvenc');
    await spawner.complete({
      bytes: 0,
      code: 1,
      stderr: [
        '[h264_nvenc @ 0x1] [error] OpenEncodeSessionEx failed: unsupported device (2)',
        '[out#0/matroska @ 0x2] [error] Nothing was written into output file, because at least one of its streams received no packets.',
      ],
    });
    await until('software spawn', () => spawner.calls.length === 2);
    const soft = spawner.calls[1]?.args ?? [];
    expect(soft).toContain('libx264');
    expect(soft).not.toContain('h264_nvenc');
    expect(soft).not.toContain('-hwaccel');
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job.state).toBe('done');
    expect(findJobResult(t.db, id)?.warnings).toEqual([
      'the GPU encode failed (h264_nvenc: OpenEncodeSessionEx failed: unsupported device (2)); encoded in software instead',
    ]);
  });

  it('a model renderArgs refuses → failed "render: …", never retried', async () => {
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        node('bad', 'test:stray-arg'),
        node('ro', 'core:replace-original'),
      ),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({
      state: 'failed',
      reason: 'render: globalArgs has a stray argument "stray"',
      attempt: 1,
    });
  });

  it('an mkv cover is extracted into the temp dir before the encode; a failed extraction fails the job', async () => {
    sourceProbe = probeOf(
      [
        { type: 'video', codec: 'h264', default: true },
        { type: 'audio', codec: 'aac', language: 'eng', default: true },
        { type: 'video', codec: 'png', attachedPic: true },
      ],
      { container: 'mp4', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', sizeBytes: 1000 },
    );
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        node('rm', 'core:remux', { container: 'mkv' }),
        node('ro', 'core:replace-original'),
      ),
    );
    await writeFile(join(root, 'Show', 'c.mp4'), Buffer.alloc(1000, 7));
    const id = await queue(join(root, 'Show', 'c.mp4'), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    const cover = join(transcodeDir, id, 'cover-2.png');
    expect(execCalls.some((c) => c.at(-1) === cover && c.includes('image2'))).toBe(true);
    const args = spawner.calls[0]?.args ?? [];
    expect(args[args.indexOf('-attach') + 1]).toBe(cover);
    expect(row(id).lane).toBe('quick');
    await t.deps.engine.stop();

    coverExtracts = false;
    await setup();
    const wf2 = workflow(
      line(
        node('in', 'core:input-manual'),
        node('rm', 'core:remux', { container: 'mkv' }),
        node('ro', 'core:replace-original'),
      ),
    );
    await writeFile(join(root, 'Show', 'd.mp4'), Buffer.alloc(1000, 7));
    const id2 = await queue(join(root, 'Show', 'd.mp4'), wf2);
    await t.deps.engine.start();
    expect(await settled(id2)).toMatchObject({
      state: 'failed',
      reason: 'render: cover video #2 needs its extracted image file',
    });
    expect(spawner.calls).toEqual([]);
  });

  describe('sidecar subtitle inputs', () => {
    const sidecarWorkflow = (path: string) =>
      workflow(
        line(
          node('in', 'core:input-manual'),
          node('sc', 'test:add-sidecar', { path }),
          node('ro', 'core:replace-original'),
        ),
      );

    it('ffmpeg reads a private copy in the temp dir, never the sidecar in the library', async () => {
      const original = join(root, 'Show', 'a.de.srt');
      await writeFile(original, '1\n00:00:01,000 --> 00:00:02,000\nHallo\n');
      const id = await queue(file(), sidecarWorkflow(original));
      await t.deps.engine.start();
      await until('spawn', () => spawner.calls.length === 1);
      const copy = join(transcodeDir, id, 'sidecar-1.srt');
      const args = spawner.calls[0]?.args ?? [];
      const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]] : []));
      expect(inputs).toEqual([join(root, 'Show', 'a.mkv'), copy]);
      expect(args[args.indexOf(copy) - 3]).toBe('-f');
      expect(args[args.indexOf(copy) - 2]).toBe('srt');
      expect(args).not.toContain(original);
      expect(await readFile(copy, 'utf8')).toContain('Hallo');
    });

    it('a symlinked sidecar is refused and the job fails before ffmpeg runs', async () => {
      const target = join(base, 'outside', 'secret.srt');
      await writeFile(target, 'secret');
      const link = join(root, 'Show', 'a.de.srt');
      await symlink(target, link);
      const id = await queue(file(), sidecarWorkflow(link));
      await t.deps.engine.start();
      expect(await settled(id)).toMatchObject({
        state: 'failed',
        // The realpath check refuses it first; copyRegular's O_NOFOLLOW still guards a swap after.
        reason:
          'render: subtitle file a.de.srt cannot be used: its path is not a real path in the library',
      });
      expect(spawner.calls).toEqual([]);
    });

    it('a sidecar under a symlinked parent directory is refused before ffmpeg runs', async () => {
      await mkdir(join(base, 'outside', 'subs'));
      await writeFile(join(base, 'outside', 'subs', 'a.de.srt'), 'secret');
      await symlink(join(base, 'outside', 'subs'), join(root, 'Show', 'subs'));
      const id = await queue(file(), sidecarWorkflow(join(root, 'Show', 'subs', 'a.de.srt')));
      await t.deps.engine.start();
      const job = await settled(id);
      expect(job).toMatchObject({
        state: 'failed',
        reason:
          'render: subtitle file a.de.srt cannot be used: its path is not a real path in the library',
      });
      expect(job.reason).not.toContain(base);
      expect(spawner.calls).toEqual([]);
    });

    it('a sidecar outside the library is refused before ffmpeg runs', async () => {
      const outside = join(base, 'outside', 'a.de.srt');
      await writeFile(outside, 'secret');
      const id = await queue(file(), sidecarWorkflow(outside));
      await t.deps.engine.start();
      expect(await settled(id)).toMatchObject({
        state: 'failed',
        reason:
          'render: subtitle file a.de.srt cannot be used: its path is not a real path in the library',
      });
      expect(spawner.calls).toEqual([]);
    });

    it('a sidecar over 8 MiB is refused', async () => {
      const big = join(root, 'Show', 'a.de.srt');
      await writeFile(big, Buffer.alloc(8 * 1024 * 1024 + 1, 65));
      const id = await queue(file(), sidecarWorkflow(big));
      await t.deps.engine.start();
      expect(await settled(id)).toMatchObject({
        state: 'failed',
        reason: 'render: subtitle file a.de.srt cannot be used: it is larger than 8388608 bytes',
      });
      expect(spawner.calls).toEqual([]);
    });
  });

  it('a ready job cancelled while waiting for its lane has its temp dir discarded and a cancelled result', async () => {
    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const first = await queue(file(), wf);
    const second = await queue(join(root, 'Show', 'b.mkv'), wf);
    await t.deps.engine.start();
    await until('one encoding', () => spawner.calls.length === 1);
    // Both prepare at once; whichever got the lane first runs, the other waits ready.
    const a = spawner.calls[0]?.logPath.includes(first) ? first : second;
    const b = a === first ? second : first;
    await until('b ready', () => t.deps.engine.scheduler.status().ready.includes(b));
    await mkdir(join(transcodeDir, b), { recursive: true });
    expect(t.deps.engine.scheduler.cancelJob(b)).toBe('ok');
    await until('b discarded', async () => !(await listAll(transcodeDir)).includes(`/${b}`));
    expect(row(b).state).toBe('cancelled');
    await until('b result', () => findJobResult(t.db, b) !== null);
    expect(findJobResult(t.db, b)).toMatchObject({ outcome: 'cancelled', plan: { rewrite: true } });
    expect(row(a).state).toBe('encoding');
  });

  it('a frame count off the source count fails the in-pass check', async () => {
    sourceProbe = {
      ...sourceProbe,
      raw: { streams: [{ index: 0, nb_frames: '1440' }] },
    };
    const exec: Exec = async (file, args) => {
      if (args.includes('-show_format') && !(args.at(-1) as string).startsWith(transcodeDir)) {
        const json = ffprobeJson(sourceProbe) as { streams: Record<string, unknown>[] };
        (json.streams[0] as Record<string, unknown>).nb_frames = '1440';
        return { stdout: JSON.stringify(json), stderr: '' };
      }
      return fakeExec(file, args);
    };
    await t.deps.engine.stop();
    spawner = new TestSpawner();
    t = createTestApp({
      config: { configDir, transcodeDir },
      capabilities: caps,
      spawner,
      fsOps,
      exec,
    });
    const created = await t.deps.engine.queue.createLibrary({ name: 'Lib', path: root });
    expect('kind' in created).toBe(false);
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    for (const n of [1, 2]) {
      await until(`spawn ${n}`, () => spawner.calls.length === n);
      spawner.emitProgress({ outTimeSeconds: 60, speed: 1, fps: 24, sizeBytes: 600, frames: 700 });
      await spawner.complete({ bytes: 600 });
    }
    expect(await settled(id)).toMatchObject({
      state: 'failed',
      reason: 'encode wrote 700 video frames, the source has 1440',
    });
  });
});

/** A one-shot fault: `op` throws (code `code`) the first time `when` matches its arguments. */
function faultOnce(
  base: FsOps,
  op: 'link' | 'unlink' | 'copyFile',
  when: (...args: string[]) => boolean,
  code = 'EIO',
): FsOps & { fired: () => boolean } {
  let fired = false;
  const original = base[op] as (...a: string[]) => Promise<void>;
  return {
    ...base,
    [op]: async (...args: string[]) => {
      if (!fired && when(...args)) {
        fired = true;
        throw Object.assign(new Error('injected'), { code });
      }
      return original.apply(base, args);
    },
    fired: () => fired,
  } as FsOps & { fired: () => boolean };
}

const encodeAnd = (...finish: ReturnType<typeof node>[]) =>
  workflow(line(node('in', 'core:input-manual'), toH264(), ...finish));
const replaceNode = (settings = {}) => node('ro', 'core:replace-original', settings);
const moveCopy = (mode: 'copy' | 'move' = 'copy') =>
  node('mc', 'core:move-copy', { mode, outputRoot: join(base, 'out') });

/** Runs the job through one encode that writes `bytes` and returns its final row. */
async function runOnce(id: string, bytes = 600): Promise<JobRow> {
  await t.deps.engine.start();
  await until('spawn', () => spawner.calls.length >= 1);
  await spawner.complete({ bytes });
  return settled(id);
}

describe('pipeline: fix round (review)', () => {
  it('CRIT: a move-copy failure after the replace never retries: done with the failure as a warning', async () => {
    await mkdir(join(base, 'out', 'Show'), { recursive: true });
    await writeFile(join(base, 'out', 'Show', 'a.mkv'), 'taken');
    const id = await queue(file(), encodeAnd(replaceNode(), moveCopy()));
    const job = await runOnce(id);
    expect(job).toMatchObject({ state: 'done', attempt: 1 });
    expect(job.reason).toMatch(/^finished with a problem: move-copy: .*a\.mkv already exists$/);
    expect(findJobResult(t.db, id)).toMatchObject({ afterBytes: 600, replacedTo: 'recycle' });
    expect(findJobResult(t.db, id)?.warnings).toContain(
      job.reason?.replace('finished with a problem: ', ''),
    );
    expect(spawner.calls).toHaveLength(1);
    expect((await stat(file())).size).toBe(600);
  });

  it('I4: a move-copy failure before anything was written fails (final), the original untouched', async () => {
    await mkdir(join(base, 'out', 'Show'), { recursive: true });
    await writeFile(join(base, 'out', 'Show', 'a.mkv'), 'taken');
    const id = await queue(file(), encodeAnd(moveCopy(), replaceNode()));
    const job = await runOnce(id);
    expect(job).toMatchObject({ state: 'failed', attempt: 1 });
    expect(job.reason).toMatch(/^move-copy: .*a\.mkv already exists$/);
    expect((await stat(file())).size).toBe(1000);
    expect(await readFile(join(base, 'out', 'Show', 'a.mkv'), 'utf8')).toBe('taken');
  });

  it('I4: move-copy copies the result under the output root (original untouched); move removes the temp output, an unlink error is reported', async () => {
    const id = await queue(file(), encodeAnd(moveCopy()));
    expect(await runOnce(id)).toMatchObject({ state: 'done', reason: null });
    expect((await stat(join(base, 'out', 'Show', 'a.mkv'))).size).toBe(600);
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(join(base, 'out'))).toEqual(['/Show', '/Show/a.mkv']);

    await t.deps.engine.stop();
    await setup({ fs: faultOnce(fsOps, 'unlink', (p) => p.endsWith('/out.mkv'), 'EACCES') });
    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    const id2 = await queue(join(root, 'Show', 'b.mkv'), encodeAnd(moveCopy('move')));
    const job = await runOnce(id2);
    expect(job.state).toBe('done');
    expect(findJobResult(t.db, id2)?.warnings).toEqual([
      expect.stringMatching(/^move-copy: could not remove the moved output .*out\.mkv: injected$/),
    ]);
    expect((await stat(join(base, 'out', 'Show', 'b.mkv'))).size).toBe(600);
  });

  it('I4: an output root that is not configured fails the job before anything is written', async () => {
    const wf = encodeAnd(moveCopy());
    const id = await queue(file(), wf);
    // The root is no longer configured when the job starts (the version is re-validated then).
    t.deps.config.outputRoots.length = 0;
    await t.deps.engine.start();
    const job = await settled(id);
    expect(job.state).toBe('failed');
    expect(job.reason).toMatch(/output root|workflow invalid/);
    expect(await listAll(join(base, 'out'))).toEqual([]);
  });

  it('an encoded job gives up the encoder: the next file encodes while the first is verified', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = false;
    execHook = async (_file, args) => {
      // Hold the first job's verify at its first read of the output.
      if (!held && (args.at(-1) as string).startsWith(transcodeDir)) {
        held = true;
        await gate;
      }
      return null;
    };
    const second = join(root, 'Show', 'b.mkv');
    await nodeFsOps.copyFile(file(), second);
    const wf = encodeAnd(replaceNode());
    const a = await queue(file(), wf);
    const b = await queue(second, wf);
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    // The first is verifying (held): the other gets the encoder meanwhile. Both prepare at once
    // and the slot goes to whichever is ready first, so either may be first.
    await until('second spawn while the first verifies', () => held && spawner.calls.length === 2);
    expect([row(a).state, row(b).state].sort()).toEqual(['encoding', 'verifying']);
    release();
    await spawner.complete({ bytes: 600 });
    expect(await settled(a)).toMatchObject({ state: 'done' });
    expect(await settled(b)).toMatchObject({ state: 'done' });
  });

  it('a verify failure after the encoder was given up retries in a slot of its own: it waits for the next file to finish encoding', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = false;
    execHook = async (_file, args) => {
      if (!held && (args.at(-1) as string).startsWith(transcodeDir)) {
        held = true;
        await gate;
      }
      return null;
    };
    const second = join(root, 'Show', 'b.mkv');
    await nodeFsOps.copyFile(file(), second);
    const wf = encodeAnd(replaceNode());
    const ids = [await queue(file(), wf), await queue(second, wf)];
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('second spawn while the first verifies', () => held && spawner.calls.length === 2);
    const first = ids.find((id) => row(id).state === 'verifying') as string;
    const next = ids.find((id) => id !== first) as string;
    // The first's output fails verify: it is queued again, but the slot is the other's.
    brokenOutput = true;
    release();
    await until(
      'first retried',
      () => row(first).attempt === 2 && row(first).state !== 'verifying',
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(spawner.calls).toHaveLength(2);
    expect(t.deps.engine.scheduler.status().lanes.encode).toBe(next);
    expect(row(next).state).toBe('encoding');
    // The other finishes encoding: the retry takes the slot back and encodes again.
    brokenOutput = false;
    await spawner.complete({ bytes: 600 });
    await until('third spawn', () => spawner.calls.length === 3);
    expect(row(first)).toMatchObject({ state: 'encoding', attempt: 2 });
    await spawner.complete({ bytes: 600 });
    expect(await settled(first)).toMatchObject({ state: 'done', attempt: 2 });
    expect(await settled(next)).toMatchObject({ state: 'done', attempt: 1 });
  });

  it('I4: a cancel while move-copy writes removes its tmp and ends cancelled', async () => {
    await t.deps.engine.stop();
    let id = '';
    await setup({
      fs: {
        ...fsOps,
        copyFile: async (src, dst) => {
          await nodeFsOps.copyFile(src, dst);
          if (dst.includes(`${base}/out/`)) t.deps.engine.scheduler.cancelJob(id);
        },
      },
    });
    id = await queue(file(), encodeAnd(moveCopy()));
    expect(await runOnce(id)).toMatchObject({ state: 'cancelled' });
    expect(await listAll(join(base, 'out'))).toEqual(['/Show']);
  });

  it('I1: each attempt writes its own log, truncated at start; the in-pass check sees only this attempt', async () => {
    const id = await queue(file(), encodeAnd(replaceNode()));
    // A stale log of attempt 1 from an earlier run of this job.
    await mkdir(join(configDir, 'logs', 'jobs'), { recursive: true });
    await writeFile(join(configDir, 'logs', 'jobs', `${id}.attempt-1.log`), 'stale\n');
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600, stderr: ['[out#0/matroska @ 0x1] [error] write error'] });
    await until('second spawn', () => spawner.calls.length === 2);
    // While attempt 2 runs, the log shown is attempt 2's (empty so far).
    expect(await t.deps.engine.jobLog(id)).toBe('');
    await spawner.complete({ bytes: 600, stderr: ['[libx264 @ 0x1] [warning] fine'] });
    expect(await settled(id)).toMatchObject({ state: 'done', attempt: 2 });
    const [one, two] = spawner.calls.map((c) => c.logPath);
    expect(one).toBe(join(configDir, 'logs', 'jobs', `${id}.attempt-1.log`));
    expect(two).toBe(join(configDir, 'logs', 'jobs', `${id}.attempt-2.log`));
    expect(await readFile(one as string, 'utf8')).toBe(
      '[out#0/matroska @ 0x1] [error] write error\n',
    );
    expect(await readFile(two as string, 'utf8')).toBe('[libx264 @ 0x1] [warning] fine\n');
    expect(findJobResult(t.db, id)?.logPath).toBe(two);
    expect(await t.deps.engine.jobLog(id)).toBe('[libx264 @ 0x1] [warning] fine\n');
  });

  it('I3: a replace failing while installing settles at once: the replacement is installed, done with a warning', async () => {
    await t.deps.engine.stop();
    const fs = faultOnce(fsOps, 'link', (_a, b) => b === file());
    await setup({ fs });
    const id = await queue(file(), encodeAnd(replaceNode()));
    const job = await runOnce(id);
    expect(fs.fired()).toBe(true);
    expect(job).toMatchObject({ state: 'done', attempt: 1, replaceJournal: null });
    expect(job.reason).toBe(
      'finished with a problem: replace: installing_tmp: injected; recovered: the replacement is installed',
    );
    expect((await stat(file())).size).toBe(600);
    expect((await stat(join(root, '.transcoda-recycle', 'Show', 'a.mkv'))).size).toBe(1000);
    expect(listRecycled(t.db)).toHaveLength(1);
    expect(await listAll(join(root, 'Show'))).toEqual(['/a.mkv']);
  });

  it('final I2: installed but the .orig cannot be removed: done with replacedTo/afterBytes and a warning; the journal stays and the next start finishes it', async () => {
    await t.deps.engine.stop();
    let id = '';
    const copyPath = join(root, '.transcoda-recycle', 'Show', 'a.mkv');
    // The install fails (settled at once); recycling is off for this journal (no M1 path sets
    // that, so the test turns it off) and the .orig cannot be removed once.
    const link = faultOnce(fsOps, 'link', (_a, b) => {
      if (b !== file()) return false;
      const j = row(id).replaceJournal;
      if (j) updateJob(t.db, id, { replaceJournal: { ...j, recycling: false } }, new Date());
      return true;
    });
    const fs = faultOnce(link, 'unlink', (p) => p === copyPath, 'EACCES');
    await setup({ fs });
    id = await queue(file(), encodeAnd(replaceNode()));
    const job = await runOnce(id);
    expect(link.fired() && fs.fired()).toBe(true);
    expect(job).toMatchObject({ state: 'done', attempt: 1 });
    expect(job.reason).toBe(
      'finished with a problem: replace: installing_tmp: injected; recovered: the replacement is installed; ' +
        `the original copy ${copyPath} could not be removed, the next start retries`,
    );
    expect(findJobResult(t.db, id)).toMatchObject({
      outcome: 'done',
      afterBytes: 600,
      replacedTo: 'deleted',
    });
    expect(hasReplaceJournal(t.db, id)).toBe(true);
    expect((await stat(file())).size).toBe(600);

    // The next start removes the .orig and clears the journal; the job stays done.
    await t.deps.engine.stop();
    await t.deps.engine.start();
    await until('journal cleared', () => !hasReplaceJournal(t.db, id));
    expect(row(id).state).toBe('done');
    expect(await listAll(join(root, '.transcoda-recycle'))).toEqual(['/Show']);
    expect((await stat(file())).size).toBe(600);
  });

  it('final I3: an unexpected throw after the replace ends done with the problem, not failed', async () => {
    await t.deps.engine.stop();
    let installed = false;
    const plain = fsOps;
    await setup({
      fs: {
        ...plain,
        link: async (a, b) => {
          await plain.link(a, b);
          if (b === file()) installed = true;
        },
        // The second replace's path check meets an I/O error it does not know (rethrown).
        lstat: async (p) => {
          if (installed && p === file())
            throw Object.assign(new Error('injected'), { code: 'EIO' });
          return plain.lstat(p);
        },
      },
    });
    const id = await queue(file(), encodeAnd(replaceNode(), node('ro2', 'core:replace-original')));
    const job = await runOnce(id);
    expect(installed).toBe(true);
    expect(job).toMatchObject({ state: 'done', attempt: 1 });
    expect(job.reason).toBe('finished with a problem: internal error: injected');
    expect(findJobResult(t.db, id)).toMatchObject({
      outcome: 'done',
      afterBytes: 600,
      replacedTo: 'recycle',
    });
    expect(findJobResult(t.db, id)?.warnings).toContain('internal error: injected');
    expect((await stat(file())).size).toBe(600);
    expect(spawner.calls).toHaveLength(1);
  });

  it('final M1/M2: a pause during verify holds the job before the replace until resumed; the final state clears paused', async () => {
    const id = await queue(file(), encodeAnd(replaceNode()));
    let paused = false;
    execHook = async () => {
      // The first verify call: pause the job (no process attached, so nothing is frozen).
      if (!paused && row(id).state === 'verifying') {
        paused = true;
        expect(t.deps.engine.scheduler.pauseJob(id)).toBe('ok');
      }
      return null;
    };
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('paused in verify', () => paused && row(id).paused);
    // Verify finishes, then the job waits: nothing is replaced while it is paused.
    await new Promise((r) => setTimeout(r, 300));
    expect(row(id)).toMatchObject({ state: 'verifying', paused: true });
    expect((await stat(file())).size).toBe(1000);
    expect(t.deps.engine.scheduler.resumeJob(id)).toBe('ok');
    expect(await settled(id)).toMatchObject({ state: 'done', paused: false });
    expect((await stat(file())).size).toBe(600);
  });

  it('final M1: a final state written while paused clears paused (cancel of a paused queued job)', async () => {
    const id = await queue(file(), encodeAnd(replaceNode()));
    expect(t.deps.engine.scheduler.pauseJob(id)).toBe('ok');
    expect(row(id).paused).toBe(true);
    expect(t.deps.engine.scheduler.cancelJob(id)).toBe('ok');
    expect(row(id)).toMatchObject({ state: 'cancelled', paused: false });
  });

  it('I3: a replace failing after the original was linked to the recycle folder settles at once: original in place, failed, not retried', async () => {
    await t.deps.engine.stop();
    const fs = faultOnce(fsOps, 'unlink', (p) => p === file());
    await setup({ fs });
    const id = await queue(file(), encodeAnd(replaceNode()));
    const job = await runOnce(id);
    expect(fs.fired()).toBe(true);
    expect(job).toMatchObject({ state: 'failed', attempt: 1, replaceJournal: null });
    expect(job.reason).toBe('replace: moving_original: injected; nothing was replaced');
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(join(root, 'Show'))).toEqual(['/a.mkv']);
    expect(await listAll(join(root, '.transcoda-recycle'))).toEqual(['/Show']);
    expect(spawner.calls).toHaveLength(1);
  });

  it('I5: a replace failure the settle cannot decide (library unreachable) keeps its journal; failed, not retried', async () => {
    await t.deps.engine.stop();
    const plain = fsOps;
    const fault = faultOnce(plain, 'unlink', (p) => p === file());
    await setup({
      fs: {
        ...fault,
        exists: async (p) => (fault.fired() && p === root ? false : plain.exists(p)),
      },
    });
    const id = await queue(file(), encodeAnd(replaceNode()));
    const job = await runOnce(id);
    expect(job).toMatchObject({ state: 'failed', attempt: 1 });
    expect(job.reason).toBe(`library root unavailable: ${root}`);
    expect(hasReplaceJournal(t.db, id)).toBe(true);
    expect(spawner.calls).toHaveLength(1);
  });

  it('I5: a shutdown after the replacement tmp is written still records the completed replace as done', async () => {
    await t.deps.engine.stop();
    let stopping: Promise<void> | null = null;
    await setup({
      fs: {
        ...fsOps,
        copyFile: async (src, dst) => {
          if (dst.endsWith('.tmp') && !stopping) stopping = t.deps.engine.stop();
          return nodeFsOps.copyFile(src, dst);
        },
      },
    });
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('stop called', () => stopping !== null);
    await stopping;
    expect(row(id)).toMatchObject({ state: 'done', replaceJournal: null });
    expect((await stat(file())).size).toBe(600);
  });

  it('I5: a cancel while the replace waits for space ends cancelled; nothing moved, no journal', async () => {
    await t.deps.engine.stop();
    await setup({ fs: { ...fsOps, statfs: async () => ({ bavail: 1, bsize: 4096 }) } });
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('replacing', () => row(id).state === 'replacing');
    await until('journal', () => hasReplaceJournal(t.db, id));
    t.deps.engine.scheduler.cancelJob(id);
    expect(await settled(id)).toMatchObject({ state: 'cancelled', replaceJournal: null });
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(join(root, 'Show'))).toEqual(['/a.mkv']);
  });

  it('C4: a replace waiting for space says so on the job, in job.changed, in the log and in deep health', async () => {
    await t.deps.engine.stop();
    await setup({ fs: { ...fsOps, statfs: async () => ({ bavail: 1, bsize: 4096 }) } });
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('waiting', () => row(id).reason !== null);
    expect(row(id)).toMatchObject({
      state: 'replacing',
      reason: `waiting for 5.4 GB free on ${lib.path} (4 KB free)`,
    });
    const changed = published.filter((e) => e.type === 'job.changed' && e.jobId === id).at(-1);
    expect(changed).toMatchObject({ state: 'replacing', reason: row(id).reason });
    expect(t.deps.engine.spaceWaits.list()).toMatchObject([{ jobId: id, path: lib.path }]);
    expect(serverLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'replace waits for free space', job: id }),
    );
    expect((await t.deps.health.deep()).queue).toBe('fail');
    t.deps.engine.scheduler.cancelJob(id);
    expect(await settled(id)).toMatchObject({ state: 'cancelled' });
    expect(t.deps.engine.spaceWaits.list()).toEqual([]);
    expect(serverLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'replace stopped waiting for free space', job: id }),
    );
  });

  it('C4: recording a space wait that throws is a log line; the replace still waits and ends as it would', async () => {
    await t.deps.engine.stop();
    await setup({ fs: { ...fsOps, statfs: async () => ({ bavail: 1, bsize: 4096 }) } });
    vi.spyOn(t.deps.engine.spaceWaits, 'set').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('warned', () =>
      vi
        .mocked(serverLog.warn)
        .mock.calls.some(
          ([e]) => (e as { msg?: string }).msg === 'could not record the wait for free space',
        ),
    );
    expect(row(id).state).toBe('replacing');
    t.deps.engine.scheduler.cancelJob(id);
    expect(await settled(id)).toMatchObject({ state: 'cancelled' });
  });

  it('I5: a file moved out of the root between encode and replace fails the job (final); nothing written outside', async () => {
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    const away = join(base, 'outside', 'Show');
    await rename(join(root, 'Show'), away);
    await symlink(away, join(root, 'Show'));
    const outsideBefore = await listAll(join(base, 'outside'));
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', attempt: 1 });
    expect(job.reason).toBe('file moved before the replace: symlink escapes root');
    expect(await listAll(join(base, 'outside'))).toEqual(outsideBefore);
  });

  it('I5: ffmpeg that cannot start is retried once', async () => {
    await t.deps.engine.stop();
    await setup();
    let broken = true;
    const real = spawner.spawn.bind(spawner);
    spawner.spawn = (f: string, a: string[], o: SpawnOptions): RunnerProcess => {
      if (!broken) return real(f, a, o);
      broken = false;
      const done = Promise.reject(
        Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }),
      );
      done.catch(() => {});
      return { pid: -1, pause() {}, resume() {}, kill() {}, done };
    };
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done', attempt: 2 });
    expect(states(id)).toContain('queued');
  });

  it('I5: a library with verifyFullDecode decodes the whole output before the replace', async () => {
    expect(t.deps.engine.queue.updateLibrary(lib.id, { verifyFullDecode: true })).toMatchObject({
      verifyFullDecode: true,
    });
    const id = await queue(file(), encodeAnd(replaceNode()));
    expect(await runOnce(id)).toMatchObject({ state: 'done' });
    const out = join(transcodeDir, id, 'out.mkv');
    const whole = execCalls.filter(
      (c) => c[0] === 'ffmpeg' && c.includes(out) && !c.includes('-ss') && !c.includes('-t'),
    );
    expect(whole).toHaveLength(1);
  });

  it('C3: a cancel during verify aborts its ffmpeg runs and ends cancelled; a shutdown aborts them and writes nothing', async () => {
    execHook = async (file, args, signal) => {
      if (file !== 'ffmpeg' || !args.includes('-ss')) return null;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('verify hangs', () =>
      execCalls.some((c) => c[0] === 'ffmpeg' && c.includes('-ss')),
    );
    t.deps.engine.scheduler.cancelJob(id);
    expect(await settled(id)).toMatchObject({ state: 'cancelled' });
    expect(execSignals.some((s) => s?.aborted)).toBe(true);

    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    execCalls.length = 0;
    const id2 = await queue(join(root, 'Show', 'b.mkv'), encodeAnd(replaceNode()));
    await until('spawn 2', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600 });
    await until('verify hangs', () =>
      execCalls.some((c) => c[0] === 'ffmpeg' && c.includes('-ss')),
    );
    const before = row(id2);
    await t.deps.engine.stop();
    expect(row(id2)).toEqual(before);
    expect(before.state).toBe('verifying');
  });

  it('C3: a cancel during cover extraction aborts it', async () => {
    sourceProbe = probeOf(
      [
        { type: 'video', codec: 'h264', default: true },
        { type: 'video', codec: 'png', attachedPic: true },
      ],
      { container: 'mp4', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', sizeBytes: 1000 },
    );
    let seen: AbortSignal | undefined;
    execHook = async (_file, args, signal) => {
      if (!args.includes('image2')) return null;
      seen = signal;
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
      throw new Error('aborted');
    };
    await writeFile(join(root, 'Show', 'c.mp4'), Buffer.alloc(1000, 7));
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        node('rm', 'core:remux', { container: 'mkv' }),
        replaceNode(),
      ),
    );
    const id = await queue(join(root, 'Show', 'c.mp4'), wf);
    await t.deps.engine.start();
    await until('extracting', () => seen !== undefined);
    t.deps.engine.scheduler.cancelJob(id);
    expect(await settled(id)).toMatchObject({ state: 'cancelled' });
    expect(seen?.aborted).toBe(true);
    expect(spawner.calls).toEqual([]);
  });

  it('minor: currentNode is the last build node while encoding and verifying, null while replacing', async () => {
    const id = await queue(file(), encodeAnd(replaceNode()));
    await runOnce(id);
    const at = (state: JobState) =>
      published.find((e) => e.type === 'job.changed' && e.jobId === id && e.state === state);
    expect(at('encoding')).toMatchObject({ currentNode: { workflowPath: [], nodeId: 'ev' } });
    expect(at('verifying')).toMatchObject({ currentNode: { nodeId: 'ev' } });
    expect(at('replacing')).toMatchObject({ currentNode: null });
  });

  it('verify progress: each check is published while verifying, filling by checks done', async () => {
    const id = await queue(file(), encodeAnd(replaceNode()));
    await runOnce(id);
    const verifying = published.flatMap((e) =>
      e.type === 'job.changed' && e.jobId === id && e.state === 'verifying' ? [e.progress] : [],
    );
    expect(verifying[0]).toBeNull();
    const checks = verifying.flatMap((p) => (p?.verify ? [p.verify] : []));
    expect(checks.length).toBeGreaterThan(2);
    const total = checks[0]?.total ?? 0;
    expect(checks.at(0)).toEqual({ stage: 'checks', done: 1, total });
    expect(checks.at(-1)).toEqual({ stage: 'checks', done: total, total });
    expect(verifying.at(-1)?.percent).toBe(100);
    const replacing = published.find(
      (e) => e.type === 'job.changed' && e.jobId === id && e.state === 'replacing',
    );
    expect(replacing).toMatchObject({ progress: null });
  });

  it('minor: a NUMBER_OF_FRAMES tag that disagrees is a warning, not a failure', async () => {
    execHook = async (_file, args) => {
      if (!args.includes('-show_format') || (args.at(-1) as string).startsWith(transcodeDir)) {
        return null;
      }
      const json = ffprobeJson(sourceProbe) as { streams: Record<string, unknown>[] };
      (json.streams[0] as Record<string, unknown>).tags = { NUMBER_OF_FRAMES: '1440' };
      return { stdout: JSON.stringify(json), stderr: '' };
    };
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    spawner.emitProgress({ outTimeSeconds: 60, speed: 1, fps: 24, sizeBytes: 600, frames: 700 });
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done' });
    expect(findJobResult(t.db, id)?.warnings).toEqual([
      'encode wrote 700 video frames; the source tag NUMBER_OF_FRAMES says 1440',
    ]);
  });

  it('minor: a replace refused at its checking step is final (no retry)', async () => {
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    // Something takes the replace's tmp name beside the original (after the startup sweep).
    await writeFile(join(root, 'Show', `.transcoda-${id}.tmp`), 'not ours');
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', attempt: 1, replaceJournal: null });
    expect(job.reason).toMatch(/^replace: checking: .*\.tmp already exists$/);
    expect(spawner.calls).toHaveLength(1);
    expect((await stat(file())).size).toBe(1000);
  });

  it('minor: a node recycle folder outside the library root fails the job before anything moves', async () => {
    const id = await queue(
      file(),
      encodeAnd(replaceNode({ recycleFolder: join(base, 'outside', 'bin') })),
    );
    const job = await runOnce(id);
    expect(job).toMatchObject({ state: 'failed', attempt: 1 });
    expect(job.reason).toBe(
      `replace: recycle folder ${join(base, 'outside', 'bin')} is outside the library root ${root}`,
    );
    expect(await listAll(join(base, 'outside'))).toEqual([]);
    expect((await stat(file())).size).toBe(1000);
  });

  it('C4: error lines are classified per message family', () => {
    const codecs = new Set(['h264', 'hevc', 'aac']);
    const cases: [string, 'source' | 'output'][] = [
      ['[in#0/matroska,webm @ 0x1] [error] 0x00 at pos 300606 invalid as first byte', 'source'],
      ['[h264 @ 0x1] [error] error while decoding MB 15 10', 'source'],
      ['[hevc @ 0x1] [error] Could not find ref with POC 21', 'source'],
      [
        '[vist#0:0/h264 @ 0x1] [dec:h264 @ 0x2] [error] Error submitting packet to decoder',
        'source',
      ],
      ['[aist#0:1/aac @ 0x1] [error] Error while decoding stream', 'source'],
      ['[dec:hevc @ 0x1] [error] Decoding error: Invalid data found', 'source'],
      ['[libx264 @ 0x1] [error] malloc of size 1 failed', 'output'],
      ['[vost#0:0/libx265 @ 0x1] [error] Error while encoding', 'output'],
      ['[out#0/matroska @ 0x1] [error] Error writing trailer: No space left on device', 'output'],
      ['[matroska @ 0x1] [error] Error writing packet', 'output'],
      ['[aac @ 0x1] [error] Too many bits per frame requested', 'output'],
      ['[error] Conversion failed!', 'output'],
    ];
    for (const [line, side] of cases) {
      // aac is also an encoder of this job: a bare [aac @ …] is the output's.
      expect([line, classifyErrorLine(line, codecs, new Set(['libx264', 'aac']))]).toEqual([
        line,
        side,
      ]);
    }
    expect(classifyErrorLine('[h264 @ 0x1] [warning] something', codecs, new Set())).toBeNull();
  });
});

describe('pipeline: test-encode dry runs', () => {
  const PASS_URL = 'https://hooks.example.com/pass';
  const ELSE_URL = 'https://hooks.example.com/else';
  const hook = (id: string, url: string) =>
    node(id, 'core:notify-webhook', { url, method: 'POST' });
  const ro = () => node('ro', 'core:replace-original');
  const input = () => node('in', 'core:input-manual');
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const traceOf = (id: string, nodeId: string) =>
    listTrace(t.db, id)
      .filter((e) => e.nodeId === nodeId)
      .map((e) => [e.phase, e.port, e.reason]);
  const gone = (p: string) =>
    stat(p).then(
      () => false,
      () => true,
    );

  it('test-encode: encodes, verifies and ends dry_run with the measured size; the library is untouched', async () => {
    const wf = workflow(line(input(), toH264(), ro(), hook('nw', PASS_URL)));
    const libraryBefore = await listAll(root);
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(row(id).testEncode).toBe(true);
    const job = await runOnce(id, 600);
    expect(job).toMatchObject({ state: 'dry_run', reason: null });
    const result = findJobResult(t.db, id);
    expect(result).toMatchObject({
      outcome: 'dry_run',
      beforeBytes: 1000,
      afterBytes: 600,
      replacedTo: null,
    });
    expect(result?.command).not.toBeNull();
    expect(await listAll(root)).toEqual(libraryBefore);
    expect(await readFile(file())).toEqual(Buffer.alloc(1000, 7));
    expect(listRecycled(t.db)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawner.calls).toHaveLength(1);
    expect(await gone(join(transcodeDir, id))).toBe(true);
  });

  it('test-encode: a failing gate ends kept_original with the real saving and runs no else step', async () => {
    const wf = workflow(gated(50, [ro(), hook('pn', PASS_URL)], [hook('en', ELSE_URL)]));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    const job = await runOnce(id, 900);
    expect(job).toMatchObject({ state: 'kept_original', reason: 'saved only 10.0%, below 50%' });
    expect(findJobResult(t.db, id)).toMatchObject({ outcome: 'kept_original', afterBytes: 900 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.deps.engine.jobDetail(id)?.path.map((s) => s.nodeId)).toEqual([
      'in',
      'ev',
      'sg',
      'en',
    ]);
    expect(traceOf(id, 'sg').at(-1)).toEqual([
      'finish',
      'else',
      'Size gate: saved 10.0%, below 50% → no',
    ]);
    expect(await readFile(file())).toEqual(Buffer.alloc(1000, 7));
    expect(await gone(join(transcodeDir, id))).toBe(true);
  });

  it('test-encode: a passing gate is traced and the job would replace', async () => {
    const wf = workflow(gated(10, [ro()], []));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(await runOnce(id, 600)).toMatchObject({ state: 'dry_run', reason: null });
    expect(traceOf(id, 'sg').at(-1)).toEqual([
      'finish',
      'pass',
      'Size gate: saved 40.0%, at least 10% → yes',
    ]);
    expect(await readFile(file())).toEqual(Buffer.alloc(1000, 7));
  });

  it('test-encode: a move-copy workflow puts nothing in the output root', async () => {
    const out = join(base, 'out');
    const wf = workflow(
      line(input(), toH264(), node('mc', 'core:move-copy', { mode: 'copy', outputRoot: out })),
    );
    const libraryBefore = await listAll(root);
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(await runOnce(id, 600)).toMatchObject({ state: 'dry_run', reason: null });
    expect(findJobResult(t.db, id)?.afterBytes).toBe(600);
    expect(await listAll(out)).toEqual([]);
    expect(await listAll(root)).toEqual(libraryBefore);
    expect(await readFile(file())).toEqual(Buffer.alloc(1000, 7));
  });

  it('test-encode: with two gates the first failing one decides', async () => {
    const wf = workflow(
      line(
        input(),
        toH264(),
        node('g1', 'core:size-gate', { minSavingPercent: 10 }),
        node('g2', 'core:size-gate', { minSavingPercent: 50 }),
        ro(),
      ),
    );
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(await runOnce(id, 600)).toMatchObject({
      state: 'kept_original',
      reason: 'saved only 40.0%, below 50%',
    });
    expect(traceOf(id, 'g1').at(-1)).toEqual([
      'finish',
      'pass',
      'Size gate: saved 40.0%, at least 10% → yes',
    ]);
    expect(traceOf(id, 'g2').at(-1)).toEqual([
      'finish',
      'else',
      'Size gate: saved 40.0%, below 50% → no',
    ]);
    expect(await readFile(file())).toEqual(Buffer.alloc(1000, 7));
  });

  it('test-encode: a verify failure fails the dry run after one retry', async () => {
    brokenOutput = true;
    const wf = workflow(line(input(), toH264(), ro()));
    const libraryBefore = await listAll(root);
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    expect(row(id)).toMatchObject({ attempt: 2 });
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', attempt: 2 });
    expect(job.reason).toMatch(/^verify:/);
    expect(await listAll(root)).toEqual(libraryBefore);
    expect(await readFile(file())).toEqual(Buffer.alloc(1000, 7));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test-encode: queued behind a real job in the encode lane', async () => {
    const b = join(root, 'Show', 'b.mkv');
    await writeFile(b, Buffer.alloc(1000, 8));
    const wf = workflow(line(input(), toH264(), ro()));
    const real = await queue(file(), wf);
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    const test = await queue(b, wf, { dryRun: true, testEncode: true });
    const inputOf = (i: number) => {
      const args = spawner.calls[i]?.args ?? [];
      return args[args.indexOf('-i') + 1];
    };
    expect(inputOf(0)).toBe(file());
    // The test-encode waits for the lane: nothing else spawns while the real job encodes.
    await until('test-encode waiting for the encode lane', () => row(test).lane === 'encode');
    await new Promise((r) => setTimeout(r, 50));
    expect(spawner.calls).toHaveLength(1);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    expect(inputOf(1)).toBe(b);
    await spawner.complete({ bytes: 600 });
    expect(await settled(real)).toMatchObject({ state: 'done' });
    expect(await settled(test)).toMatchObject({ state: 'dry_run' });
    expect(await readFile(b)).toEqual(Buffer.alloc(1000, 8));
  });

  const kept = (id: string) => join(transcodeDir, 'test-outputs', `${id}.mkv`);
  const twoHoursOn = () => new Date(t.clock.now().getTime() + 2 * 3_600_000).toISOString();

  it('test-encode keeps the verified output', async () => {
    const wf = workflow(line(input(), toH264(), ro()));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(await runOnce(id, 600)).toMatchObject({ state: 'dry_run' });
    expect(t.deps.engine.jobDetail(id)).toMatchObject({
      testOutput: { container: 'mkv', sizeBytes: 600, keptUntil: twoHoursOn() },
      testOutputNote: null,
    });
    expect((await stat(kept(id))).size).toBe(600);
    expect(await gone(join(transcodeDir, id))).toBe(true);
  });

  it('test-encode: a failing gate keeps the output too', async () => {
    const wf = workflow(gated(50, [ro()], []));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(await runOnce(id, 900)).toMatchObject({ state: 'kept_original' });
    expect(t.deps.engine.jobDetail(id)?.testOutput).toMatchObject({ sizeBytes: 900 });
    expect((await stat(kept(id))).size).toBe(900);
  });

  it('test-encode: a verify failure keeps nothing', async () => {
    brokenOutput = true;
    const wf = workflow(line(input(), toH264(), ro()));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'failed' });
    expect(t.deps.engine.jobDetail(id)).toMatchObject({ testOutput: null, testOutputNote: null });
    expect(await listAll(transcodeDir)).toEqual([]);
  });

  it('test-encode: a cancelled test-encode keeps nothing', async () => {
    const wf = workflow(line(input(), toH264(), ro()));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    expect(t.deps.engine.scheduler.cancelJob(id)).toBe('ok');
    expect(await settled(id)).toMatchObject({ state: 'cancelled' });
    expect(t.deps.engine.jobDetail(id)?.testOutput).toBeNull();
    expect(await listAll(transcodeDir)).toEqual([]);
  });

  it('test-encode: a real job evicts kept outputs when scratch is low before it encodes', async () => {
    await t.deps.engine.stop();
    // Scratch is low while a kept output sits in test-outputs (once the first one is kept).
    let squeeze = false;
    const outputs = join(transcodeDir, 'test-outputs');
    await setup({
      fs: {
        ...fsOps,
        statfs: async (p) =>
          squeeze && p === outputs && readdirSync(outputs).length > 0
            ? { bavail: 1, bsize: 4096 }
            : { bavail: 1e9, bsize: 4096 },
      },
    });
    const wf = workflow(line(input(), toH264(), ro()));
    const test = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(await runOnce(test, 600)).toMatchObject({ state: 'dry_run' });
    expect(t.deps.engine.jobDetail(test)?.testOutput).not.toBeNull();
    squeeze = true;
    const real = await queue(file(), wf);
    await until('second spawn', () => spawner.calls.length === 2);
    expect(t.deps.engine.jobDetail(test)).toMatchObject({
      testOutput: null,
      testOutputNote: 'deleted: scratch space was needed',
    });
    expect(await gone(kept(test))).toBe(true);
    await spawner.complete({ bytes: 600 });
    expect(await settled(real)).toMatchObject({ state: 'done' });
  });

  it('plan-only dry run unchanged', async () => {
    const wf = workflow(line(input(), toH264(), ro()));
    const id = await queue(file(), wf, { dryRun: true });
    expect(row(id).testEncode).toBe(false);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'dry_run' });
    expect(spawner.calls).toEqual([]);
    expect(findJobResult(t.db, id)?.afterBytes).toBeNull();
  });
});

describe('pipeline helpers', () => {
  it('estimateBytes is the median ratio × before, null without history', () => {
    const app = createTestApp();
    expect(estimateBytes(app.db, 'nope', 1000)).toBeNull();
  });

  it('planOf marks an added track and keeps a note per stream', () => {
    const probe = probeOf([
      { type: 'video', codec: 'hevc', default: true },
      { type: 'audio', codec: 'eac3', language: 'eng', default: true, channels: 6 },
    ]);
    const model = modelFromProbe(probe);
    const main = model.streams[1];
    if (!main) throw new Error('no audio');
    main.default = false;
    model.streams.push({
      ...main,
      mode: 'convert',
      codec: 'aac',
      encoder: 'aac',
      bitrateKbps: 160,
      channels: 2,
      default: true,
      order: 2,
    });
    const plan = planOf(model, probe, 'eng');
    expect(plan.rewrite).toBe(true);
    expect(plan.streams.map((s) => [s.index, s.action, s.default, s.isOriginalLanguage])).toEqual([
      [0, 'keep', { before: true, after: true }, false],
      [1, 'keep', { before: true, after: false }, true],
      [1, 'convert', { before: false, after: true }, true],
    ]);
    expect(plan.streams[2]?.note).toMatch(/^added: convert eac3→aac/);
  });

  it('planOf lists the output tracks in output order, without mkv covers, each with its source stream', () => {
    const probe = probeOf([
      { type: 'video', codec: 'hevc', default: true },
      { type: 'audio', codec: 'truehd', language: 'eng', default: true },
      { type: 'audio', codec: 'aac', language: 'jpn' },
      { type: 'video', codec: 'mjpeg', attachedPic: true },
      { type: 'subtitle', codec: 'subrip', language: 'eng' },
    ]);
    const model = modelFromProbe(probe);
    const [video, truehd, aac, cover, sub] = model.streams;
    if (!video || !truehd || !aac || !cover || !sub) throw new Error('streams missing');
    // jpn first: the output's first audio track is the aac one.
    setOrder(model, [video, aac, truehd, cover, sub]);
    expect(planOf(model, probe, 'jpn').output).toEqual([
      { type: 'video', codec: 'hevc', sourceIndex: 0 },
      { type: 'audio', codec: 'aac', sourceIndex: 2 },
      { type: 'audio', codec: 'truehd', sourceIndex: 1 },
      { type: 'subtitle', codec: 'subrip', sourceIndex: 4 },
    ]);
  });

  it('planOf gives an output track its bit depth and channels: the encode, else the source', () => {
    const probe = probeOf([
      { type: 'video', codec: 'h264', default: true, bitDepth: 8 },
      { type: 'audio', codec: 'eac3', language: 'eng', default: true, channels: 6 },
      { type: 'audio', codec: 'dts', language: 'jpn', channels: 8 },
    ]);
    const model = modelFromProbe(probe);
    const [video, eac3, dts] = model.streams;
    if (!video || !eac3 || !dts) throw new Error('streams missing');
    Object.assign(video, { mode: 'convert', codec: 'hevc', pixelFormat: 'yuv420p10le' });
    Object.assign(dts, { mode: 'convert', codec: 'aac', channels: 2 });
    expect(planOf(model, probe, null).output).toEqual([
      { type: 'video', codec: 'hevc', sourceIndex: 0, bitDepth: 10 },
      { type: 'audio', codec: 'eac3', sourceIndex: 1, channels: 6 },
      { type: 'audio', codec: 'aac', sourceIndex: 2, channels: 2 },
    ]);
  });

  it('planOf appends normalizeDefaults notes to the diff note', () => {
    const probe = probeOf([
      { type: 'video', codec: 'hevc', default: true },
      { type: 'audio', codec: 'aac', language: 'eng' },
      { type: 'audio', codec: 'aac', language: 'deu' },
    ]);
    const model = { ...modelFromProbe(probe), container: 'mp4' as const };
    const notes = normalizeDefaults(model);
    const plan = planOf(model, probe, null, notes);
    expect(plan.streams.map((s) => [s.index, s.default.after, s.note])).toEqual([
      [0, true, ''],
      [1, true, 'default; no audio track was default'],
      [2, false, ''],
    ]);
  });

  it('planOf lists sidecar files apart from the probe streams', () => {
    const probe = probeOf([{ type: 'video', codec: 'hevc', default: true }, { type: 'audio' }]);
    let model = withSidecar(modelFromProbe(probe), 1, 'Show.de.srt', { forced: true });
    model = withSidecar(model, 2, 'Show.fr.sup', { language: 'fra', codec: 'hdmv_pgs_subtitle' });
    model = { ...model, container: 'mp4' };
    fitToContainer(model);
    const plan = planOf(model, probe, null);
    expect(plan.streams.map((s) => s.index)).toEqual([0, 1]);
    expect(plan.rewrite).toBe(true);
    // A track from a subtitle file has no source stream in the probe.
    expect(plan.output?.map((o) => o.sourceIndex)).toEqual([0, 1, null]);
    expect(plan.sidecars).toEqual([
      {
        file: 'Show.de.srt',
        language: 'deu',
        forced: true,
        sdh: false,
        codec: 'mov_text',
        action: 'embed',
        note: '',
      },
      {
        file: 'Show.fr.sup',
        language: 'fra',
        forced: false,
        sdh: false,
        codec: 'hdmv_pgs_subtitle',
        action: 'drop',
        note: "container can't hold it",
      },
    ]);
  });

  it('planOf has no sidecars key without extra inputs', () => {
    const probe = probeOf([{ type: 'video' }]);
    expect(planOf(modelFromProbe(probe), probe, null).sidecars).toBeUndefined();
  });

  it('redactUrl keeps only scheme and host', () => {
    expect(redactUrl(`https://h.example:8443/a/${SECRET}?t=${SECRET}`)).toBe(
      'https://h.example:8443/…',
    );
    expect(redactUrl('not a url')).toBe('an invalid URL');
  });
});

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
    brokenOutput = true;
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
    expect(failed).toMatchObject({ state: 'failed', attempt: 1 });
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

describe('core:embed-sidecar-subtitles in the pipeline', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nHallo\n';
  const sidecar = (name: string) => join(root, 'Show', name);
  const recycled = (name: string) => join(root, '.transcoda-recycle', 'Show', name);
  const embedWorkflow = (
    settings: Parameters<typeof node>[2] = {},
    ...more: ReturnType<typeof node>[]
  ) =>
    workflow(
      line(
        node('in', 'core:input-manual'),
        node('es', 'core:embed-sidecar-subtitles', settings),
        ...more,
        node('ro', 'core:replace-original'),
      ),
    );
  const withGerman = (container: 'mkv' | 'mp4' = 'mkv', codec = 'subrip') =>
    probeOf(
      [
        { type: 'video', codec: 'hevc', default: true },
        { type: 'audio', codec: 'aac', language: 'eng', default: true },
        { type: 'subtitle', codec, language: 'deu', default: container === 'mp4' },
      ],
      container === 'mp4'
        ? { sizeBytes: 600, container: 'mp4', formatName: 'mov,mp4,m4a,3gp,3g2,mj2' }
        : { sizeBytes: 600 },
    );

  it('dry run: the plan lists the embed rows and the summary says so; nothing moves', async () => {
    await writeFile(sidecar('a.de.srt'), srt);
    const id = await queue(file(), embedWorkflow(), { dryRun: true });
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'dry_run' });
    const plan = findJobResult(t.db, id)?.plan;
    expect(plan?.sidecars).toEqual([
      expect.objectContaining({ file: 'a.de.srt', language: 'deu', action: 'embed' }),
    ]);
    expect(planSummary(plan as NonNullable<typeof plan>)).toContain('embed 1 subtitle file');
    expect(listTrace(t.db, id).find((e) => e.nodeId === 'es')?.reason).toBe('embed a.de.srt (deu)');
    expect(spawner.calls).toEqual([]);
    expect(await readFile(sidecar('a.de.srt'), 'utf8')).toBe(srt);
  });

  it('real run: done, and the embedded sidecar is in the recycle folder with a recycled row', async () => {
    await writeFile(sidecar('a.de.srt'), srt);
    outputProbe = withGerman();
    const id = await queue(file(), embedWorkflow());
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done', reason: null });
    expect(await readFile(recycled('a.de.srt'), 'utf8')).toBe(srt);
    expect(await nodeFsOps.exists(sidecar('a.de.srt'))).toBe(false);
    expect(listRecycled(t.db).map((r) => r.path)).toEqual(
      expect.arrayContaining([recycled('a.mkv'), recycled('a.de.srt')]),
    );
  });

  it("afterEmbed 'keep': the sidecar stays; a second run sees the embedded track and ends nothing_to_do", async () => {
    await writeFile(sidecar('a.de.srt'), srt);
    outputProbe = withGerman();
    const wf = embedWorkflow({ afterEmbed: 'keep' });
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done', reason: null });
    expect(await readFile(sidecar('a.de.srt'), 'utf8')).toBe(srt);
    expect(await nodeFsOps.exists(recycled('a.de.srt'))).toBe(false);

    sourceProbe = withGerman();
    const again = await queue(file(), wf);
    const job = await settled(again);
    expect(job).toMatchObject({ state: 'nothing_to_do' });
    expect(listTrace(t.db, again).find((e) => e.nodeId === 'es')?.reason).toBe(
      'no subtitle file embedded; skipped a.de.srt: already has deu',
    );
    expect(spawner.calls).toHaveLength(1);
  });

  it('embed before a remux to mp4: the .sup is planned as drop and never recycled; the .srt is', async () => {
    await writeFile(sidecar('a.de.srt'), srt);
    await writeFile(sidecar('a.fr.sup'), Buffer.from([0x50, 0x47, 1, 2]));
    outputProbe = withGerman('mp4', 'mov_text');
    const id = await queue(
      file(),
      embedWorkflow(
        {},
        node('rm', 'core:remux', { container: 'mp4', subtitleConversion: 'drop-incompatible' }),
      ),
    );
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    expect(findJob(t.db, id)).toBeTruthy();
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done', reason: null });
    expect(findJobResult(t.db, id)?.plan?.sidecars).toEqual([
      expect.objectContaining({ file: 'a.de.srt', action: 'embed' }),
      expect.objectContaining({
        file: 'a.fr.sup',
        action: 'drop',
        note: "container can't hold it",
      }),
    ]);
    expect(listTrace(t.db, id).find((e) => e.nodeId === 'rm')?.reason).toContain(
      "dropped (container can't hold it): a.fr.sup hdmv_pgs_subtitle",
    );
    expect(await nodeFsOps.exists(sidecar('a.fr.sup'))).toBe(true);
    expect(await nodeFsOps.exists(recycled('a.fr.sup'))).toBe(false);
    expect(await readFile(recycled('a.de.srt'), 'utf8')).toBe(srt);
  });

  it('a sidecar that cannot be recycled is a problem on a done job, never a failure', async () => {
    await writeFile(sidecar('a.de.srt'), srt);
    outputProbe = withGerman();
    const id = await queue(file(), embedWorkflow());
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await rm(sidecar('a.de.srt'));
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job.state).toBe('done');
    expect(job.reason).toMatch(
      /^finished with a problem: subtitle file a\.de\.srt could not be recycled: /,
    );
  });
});

describe('cover extraction on big files (the PAW Patrol failures)', () => {
  it('the time limit grows with the file: 60 s plus 1 s per 100 MB', () => {
    expect(coverTimeoutMs(0)).toBe(60_000);
    expect(coverTimeoutMs(30_000_000_000)).toBe(360_000);
  });

  it("a stopped extraction says it took too long; another failure keeps ffmpeg's last line", () => {
    expect(
      coverFailure(
        Object.assign(new Error('Command failed: ffmpeg …'), { killed: true }),
        11,
        360_000,
      ),
    ).toBe(
      'render: copying the cover (video #11) out of the file took longer than 6 min and was stopped',
    );
    const err = Object.assign(new Error('Command failed: ffmpeg …'), {
      stderr: '[matroska @ 0x55d0] Invalid data\ncover.jpg: Invalid argument\n',
    });
    expect(coverFailure(err, 3, 60_000)).toBe(
      'render: the cover (video #3) could not be copied out of the file: cover.jpg: Invalid argument',
    );
  });
});
