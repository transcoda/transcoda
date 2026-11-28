// Shared setup for the RPC tests that run the engine over the whole app (jobs, libraries, queue,
// runs, system.capabilities): a fake ffmpeg and ffprobe, a temp library, helpers to queue and wait.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import type { JobState } from '@transcoda/shared';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { createTestApp, type TestApp } from '../../app/testing/app.ts';
import { asSession, login, type Session, send } from '../../app/testing/http.ts';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import { findJob, type JobRow } from '../../db/repos/jobs/jobs.ts';
import { FakeSpawner } from '../../engine/encode/process.ts';
import { packetRows } from '../../engine/testing/builders.ts';
import { tempDir } from '../../engine/testing/fixtures.ts';
import { type FsOps, nodeFsOps } from '../../platform/fs-ops.ts';
import { chain, node } from '../../workflows/testing.ts';

/** How long `until` waits; well above any healthy run, below the raised test timeout. */
export const UNTIL_MS = 10_000;

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '9.0.2',
  encoders: ['aac', 'libx264', 'libx265'],
  hwaccels: [],
  filters: ['pan'],
};

/**
 * ffprobe answers for a 60 s hevc+aac mkv (h264 once encoded into the temp dir), packets that end
 * at 60 s, a keyframe at 55 s; ffmpeg runs succeed quietly.
 */
const exec: Exec = async (_file, args) => {
  const output = (args.at(-1) as string).startsWith(transcodeDir);
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
          codec_name: output ? 'h264' : 'hevc',
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
  if (args.includes('packet=stream_index,pts_time,duration_time'))
    return { stdout: packetRows('59.96,0.04'), stderr: '' };
  if (args.includes('-read_intervals')) return { stdout: packetRows('55.0,1000,K__'), stderr: '' };
  return { stdout: '', stderr: '' };
};

export const SECRET = 'hook-secret-7f3a';
const fsOps: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) };

export let base: string;
export let root: string;
export let outside: string;
let configDir: string;
export let transcodeDir: string;
export let spawner: FakeSpawner;
export let t: TestApp;
export let s: Session;

/**
 * Polls `pred` every 5 ms for up to {@link UNTIL_MS} (a fast run costs nothing; a loaded machine,
 * e.g. `pnpm check` with the real-ffmpeg suites in parallel, gets time). The test timeout is raised
 * to match (vi.setConfig below).
 */
export async function until(what: string, pred: () => boolean): Promise<void> {
  const deadline = Date.now() + UNTIL_MS;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const row = (id: string): JobRow => findJob(t.db, id) as JobRow;
export const isFinal = (id: string) =>
  (['done', 'failed', 'cancelled', 'dry_run', 'kept_original'] as JobState[]).includes(
    row(id).state,
  );

/**
 * An enabled encode workflow (in → encode h264 → replace → optional notify). With `libraryId` its
 * input is a Library input naming that library, so it feeds the library.
 */
export function encodeWorkflow(opts: { notify?: boolean; libraryId?: string } = {}): string {
  const { id } = t.deps.workflows.create({ name: 'Encode', kind: 'workflow' }, 'u');
  const nodes = [
    opts.libraryId === undefined
      ? node('in', 'core:input-manual')
      : node('in', 'core:input-library', { libraryId: opts.libraryId }),
    node('ev', 'core:encode-video', { codec: 'h264', encoder: 'libx264', skipIf: 'never' }),
    node('ro', 'core:replace-original'),
    ...(opts.notify
      ? [node('nw', 'core:notify-webhook', { url: `https://hooks.example/${SECRET}` })]
      : []),
  ];
  t.deps.workflows.save({ id, baseVersion: 1, graph: chain('workflow', ...nodes) }, 'u');
  expect(t.deps.workflows.activate(id, 2, 'u').kind).toBe('ok');
  return id;
}

export async function createLibrary(body: Record<string, unknown>): Promise<Response> {
  return send(t, 'POST', '/libraries', { body, headers: asSession(s, true) });
}

export async function library(): Promise<string> {
  const res = await createLibrary({ name: 'TV', path: root });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** The TV library and the active encode workflow that feeds it (a queue without workflowId uses it). */
export async function fedLibrary(
  opts: { notify?: boolean } = {},
): Promise<{ wf: string; id: string }> {
  const id = await library();
  return { wf: encodeWorkflow({ ...opts, libraryId: id }), id };
}

export async function queue(
  body: Record<string, unknown>,
  headers: Record<string, string> = asSession(s, true),
): Promise<Response> {
  return send(t, 'POST', '/jobs', { body, headers });
}

export async function queued(
  body: Record<string, unknown>,
): Promise<{ runId: string; jobIds: string[]; testEncode: boolean }> {
  const res = await queue(body);
  expect(res.status).toBe(200);
  return (await res.json()) as { runId: string; jobIds: string[]; testEncode: boolean };
}

/** Finishes the latest fake ffmpeg run: writes `bytes` to its output and exits 0. */
export async function finishEncode(bytes: number): Promise<void> {
  const call = spawner.calls.at(-1);
  if (!call) throw new Error('no spawn');
  await writeFile(call.args.at(-1) as string, Buffer.alloc(bytes, 1));
  await writeFile(call.logPath, 'frame=1\n');
  spawner.exit(0);
}

export const get = async (path: string, headers: Record<string, string> = asSession(s, false)) =>
  send(t, 'GET', path, { headers });
export const json = async <T = Record<string, unknown>>(res: Response): Promise<T> =>
  (await res.json()) as T;

/** Reads server-sent events from a response until `enough` says stop (or 200 events). */
export async function readEvents(
  res: Response,
  enough: (events: { type: string }[]) => boolean,
): Promise<Record<string, unknown>[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let buffer = '';
  while (events.length < 200 && !enough(events as { type: string }[])) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (data !== '') events.push(JSON.parse(data) as Record<string, unknown>);
      end = buffer.indexOf('\n\n');
    }
  }
  await reader.cancel();
  return events;
}

/**
 * Registers the setup and teardown every test in these files shares. `devPlugins`: bundles started
 * as dev plugins before each test (the plugin service is started too).
 */
export function useRpcApp(opts: { devPlugins?: () => string[] } = {}): void {
  vi.setConfig({ testTimeout: 30_000 });
  beforeEach(async () => {
    base = await tempDir('rpc-engine-');
    root = join(base, 'lib');
    outside = join(base, 'outside');
    configDir = join(base, 'config');
    transcodeDir = join(base, 'transcode');
    await mkdir(join(root, 'Show', 'Season 1'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, 'a.mkv'), Buffer.alloc(1000, 7));
    await writeFile(join(outside, 'x.mkv'), Buffer.alloc(1000, 7));
    spawner = new FakeSpawner();
    t = createTestApp({
      config: { configDir, transcodeDir, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' },
      capabilities: caps,
      spawner,
      fsOps,
      exec,
      heartbeatMs: 10,
      ...(opts.devPlugins ? { plugins: { devPlugins: opts.devPlugins() } } : {}),
    });
    await t.deps.engine.start();
    if (opts.devPlugins) await t.deps.plugins.start();
    s = await login(t);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.deps.engine.stop();
    if (opts.devPlugins) await t.close();
    await rm(base, { recursive: true, force: true });
  });
}
