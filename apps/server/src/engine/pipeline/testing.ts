import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import { type AnyNodeDefinition, defineNode, type ProbeResult } from '@transcoda/sdk';
import type { JobState, WorkflowGraph } from '@transcoda/shared';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { z } from 'zod';
import { createTestApp, type TestApp } from '../../app/testing/app.ts';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import { findJob, type JobRow } from '../../db/repos/jobs/jobs.ts';
import type { LibraryRow } from '../../db/repos/libraries.ts';
import type { RegisteredNode } from '../../nodes/registry.ts';
import { type FsOps, nodeFsOps } from '../../platform/fs-ops.ts';
import type { Logger } from '../../platform/logger.ts';
import type { PluginHooksRunner } from '../../plugins/runtime/hooks.ts';
import { edge, mainGraph, node, testRegistry } from '../../workflows/testing.ts';
import { FakeSpawner } from '../encode/process.ts';
import type { EngineEvent } from '../events.ts';
import { packetRows, probeOf, withSidecar } from '../testing/builders.ts';
import { tempDir } from '../testing/fixtures.ts';

/** How long `until` waits; well above any healthy run, below the raised test timeout. */
export const UNTIL_MS = 10_000;
vi.setConfig({ testTimeout: 30_000 });

export const caps: Extract<Capabilities, { available: true }> = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '9.0.2',
  encoders: ['aac', 'libx264', 'libx265', 'h264_nvenc'],
  hwaccels: [],
  filters: ['pan'],
};

/** ffprobe's JSON for a hand-built probe (what parseProbe reads back). */
export function ffprobeJson(p: ProbeResult): unknown {
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
      ...(s.frameRate ? { avg_frame_rate: `${s.frameRate}/1` } : {}),
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
export const originalLanguage: AnyNodeDefinition = defineNode({
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
export const strayArg: AnyNodeDefinition = defineNode({
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
export const setProfile: AnyNodeDefinition = defineNode({
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
export const addSidecar: AnyNodeDefinition = defineNode({
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
export class TestSpawner extends FakeSpawner {
  async complete(
    o: {
      bytes?: number;
      code?: number;
      leading?: string[];
      stderr?: string[];
      at?: number;
      /** The progress sample has no out time (ffmpeg 8, a copied image track), only frames. */
      noOutTime?: boolean;
    } = {},
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
        outTimeSeconds: o.noOutTime ? null : (o.at ?? 30),
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

export const SECRET = 'tok3n-s3cr3t';

export let base: string;
export let root: string;
export let transcodeDir: string;
export let configDir: string;
export let t: TestApp;
export let spawner: TestSpawner;
export let published: EngineEvent[];
/** The server log of the current `setup`. */
export let serverLog: Logger;
export let fsOps: FsOps;
export let lib: LibraryRow;
export const execCalls: string[][] = [];
/**
 * The fakes' answers a test may change (reset before each test): what ffprobe reads of the source
 * and of the output, and how the fake exec behaves.
 */
export const fake: {
  sourceProbe: ProbeResult;
  outputProbe: ProbeResult;
  /** Output packet reads answer '' (the output ends early): verify fails duration. */
  brokenOutput: boolean;
  coverExtracts: boolean;
  /** Source decodes at a spot (`-ss`) report a decoder error (the source really is damaged there). */
  sourceSpotsDamaged: boolean;
  /** Runs first for every exec call; may answer (return a result) or hang. */
  execHook:
    | ((
        file: string,
        args: string[],
        signal: AbortSignal | undefined,
      ) => Promise<{ stdout: string; stderr: string } | null>)
    | null;
} = {
  sourceProbe: probeOf([]),
  outputProbe: probeOf([]),
  brokenOutput: false,
  coverExtracts: true,
  sourceSpotsDamaged: false,
  execHook: null,
};
/** Signals passed with exec calls, for the cancel/shutdown tests. */
export const execSignals: (AbortSignal | undefined)[] = [];

export const fakeExec: Exec = async (file, args, opts) => {
  execCalls.push([file, ...args]);
  execSignals.push(opts?.signal);
  // A hooked answer's stderr arrives as a real run's does: live, after some output.
  const deliver = (stderr: unknown) => {
    if (!opts?.onStderr || typeof stderr !== 'string' || stderr === '') return;
    opts.onStdout?.('out_time_us=30000000\nprogress=continue\n');
    opts.onStderr(stderr);
  };
  let hooked: Awaited<ReturnType<NonNullable<typeof fake.execHook>>> = null;
  try {
    hooked = fake.execHook ? await fake.execHook(file, args, opts?.signal) : null;
  } catch (err) {
    deliver((err as { stderr?: unknown } | null)?.stderr);
    throw err;
  }
  if (hooked) {
    deliver(hooked.stderr);
    return hooked;
  }
  const path = args.at(-1) as string;
  const isOutput = path.startsWith(transcodeDir);
  if (
    file === 'ffmpeg' &&
    fake.sourceSpotsDamaged &&
    args.includes('-ss') &&
    args.join(' ').includes(` -i ${root}`)
  ) {
    throw Object.assign(new Error('Command failed'), {
      code: 1,
      stderr: '[h264 @ 0x1] error while decoding MB 15 10\n',
    });
  }
  if (args.includes('-show_format')) {
    return {
      stdout: JSON.stringify(ffprobeJson(isOutput ? fake.outputProbe : fake.sourceProbe)),
      stderr: '',
    };
  }
  const at = args.indexOf('-read_intervals');
  if (at >= 0 && args.includes('packet=stream_index,pts_time,duration_time')) {
    if (isOutput && fake.brokenOutput) return { stdout: '', stderr: '' };
    return { stdout: packetRows('59.960000,0.040000'), stderr: '' };
  }
  if (at >= 0) return { stdout: packetRows('55.000000,1000,K__'), stderr: '' };
  if (args.includes('image2')) {
    if (fake.coverExtracts) await writeFile(path, 'png');
    return { stdout: '', stderr: '' };
  }
  return { stdout: '', stderr: '' };
};

/**
 * Polls `pred` every 5 ms for up to {@link UNTIL_MS} (a fast run costs nothing; a loaded machine,
 * e.g. `pnpm check` with the real-ffmpeg suites in parallel, gets time). The test timeout is raised
 * to match (vi.setConfig below).
 */
export async function until(what: string, pred: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + UNTIL_MS;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function row(id: string): JobRow {
  const r = findJob(t.db, id);
  if (!r) throw new Error(`no job ${id}`);
  return r;
}

export const FINAL: JobState[] = [
  'done',
  'nothing_to_do',
  'kept_original',
  'failed',
  'cancelled',
  'dry_run',
  'skipped',
  'already_processed',
];
export async function settled(id: string): Promise<JobRow> {
  await until(`job ${id} to finish`, () => FINAL.includes(row(id).state));
  return row(id);
}

/** The job's states from job.changed events, consecutive repeats removed. */
export function states(id: string): JobState[] {
  const out: JobState[] = [];
  for (const e of published) {
    if (e.type === 'job.changed' && e.jobId === id && out.at(-1) !== e.state) out.push(e.state);
  }
  return out;
}

export function workflow(graph: WorkflowGraph, active = true): string {
  const { id } = t.deps.workflows.create({ name: `wf-${Math.random()}`, kind: 'workflow' }, 'u');
  const saved = t.deps.workflows.save({ id, baseVersion: 1, graph }, 'u');
  expect(saved.version).toBe(2);
  if (active) expect(t.deps.workflows.activate(id, 2, 'u').kind).toBe('ok');
  return id;
}

export const line = (...nodes: ReturnType<typeof node>[]): WorkflowGraph =>
  mainGraph(
    nodes,
    nodes.slice(1).map((n, i) => {
      const from = nodes[i] as ReturnType<typeof node>;
      // A size gate's or an approval's file leaves by `pass`.
      const gate = from.type === 'core:size-gate' || from.type === 'core:approval';
      return edge(from.id, n.id, gate ? { from: 'pass' } : {});
    }),
  );

/** in → encode → gate; gate.pass → `passSteps`; gate.else → `elseSteps` (each chain in order). */
export const gated = (
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

export const toH264 = () =>
  node('ev', 'core:encode-video', { codec: 'h264', encoder: 'libx264', skipIf: 'never' });

export async function queue(
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

export async function listAll(dir: string): Promise<string[]> {
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

export async function setup(
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
    encodeStallMinutes?: number;
    approvalMaxBytes?: number;
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
      ...(opts.encodeStallMinutes !== undefined
        ? { encodeStallMinutes: opts.encodeStallMinutes }
        : {}),
      ...(opts.approvalMaxBytes !== undefined ? { approvalMaxBytes: opts.approvalMaxBytes } : {}),
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
  fake.sourceProbe = probeOf(
    [
      { type: 'video', codec: 'hevc', default: true },
      { type: 'audio', codec: 'aac', language: 'eng', default: true },
    ],
    { sizeBytes: 1000 },
  );
  fake.outputProbe = probeOf(
    [
      { type: 'video', codec: 'h264', default: true },
      { type: 'audio', codec: 'aac', language: 'eng', default: true },
    ],
    { sizeBytes: 600 },
  );
  fake.brokenOutput = false;
  fake.coverExtracts = true;
  fake.sourceSpotsDamaged = false;
  fake.execHook = null;
  execCalls.length = 0;
  execSignals.length = 0;
  // Plenty of room: the replace needs 5 GB beyond the output on the original's filesystem.
  fsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) };
  await setup();
});

afterEach(async () => {
  await t.deps.engine.stop();
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

export const file = (): string => join(root, 'Show', 'a.mkv');

/** A one-shot fault: `op` throws (code `code`) the first time `when` matches its arguments. */
export function faultOnce(
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

export const encodeAnd = (...finish: ReturnType<typeof node>[]) =>
  workflow(line(node('in', 'core:input-manual'), toH264(), ...finish));
export const replaceNode = (settings = {}) => node('ro', 'core:replace-original', settings);
export const moveCopy = (mode: 'copy' | 'move' = 'copy') =>
  node('mc', 'core:move-copy', { mode, outputRoot: join(base, 'out') });

/** Runs the job through one encode that writes `bytes` and returns its final row. */
export async function runOnce(id: string, bytes = 600): Promise<JobRow> {
  await t.deps.engine.start();
  await until('spawn', () => spawner.calls.length >= 1);
  await spawner.complete({ bytes });
  return settled(id);
}

/** Stops the app and starts a new one whose ffprobe/ffmpeg runner is `exec` (no `setup` options). */
export async function restartWith(exec: Exec): Promise<void> {
  await t.deps.engine.stop();
  spawner = new TestSpawner();
  t = createTestApp({
    config: { configDir, transcodeDir },
    capabilities: caps,
    spawner,
    fsOps,
    exec,
  });
}
