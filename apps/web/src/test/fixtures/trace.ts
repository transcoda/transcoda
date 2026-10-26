import type { JobDetail, WalkStep } from '@transcoda/contract';
import type { JsonValue, TraceChanges, TraceEntry } from '@transcoda/shared';
import { tiggerPoohMain, tiggerPoohSub } from './graphs.ts';

/**
 * A hand-written job over `tiggerPoohMain` + `tiggerPoohSub`, shaped as the engine writes it
 * (apps/server/src/engine/walk.ts): the decide phase traces the trigger, conditions, Run nodes and
 * the sub-workflow's Start/End (`pass`), then the build phase traces the actions and finish nodes
 * along the decided path. `path` is the walk (`JobDetail.path`), Start/End steps included.
 */
export const SUB_ID = 'sub1';
export const SUB_VERSION = 3;

export const traceMain = () => tiggerPoohMain(SUB_ID, SUB_VERSION);
export const traceSub = () => tiggerPoohSub();

const at = (s: number) => new Date(Date.UTC(2026, 9, 16, 18, 0, s)).toISOString();

export function entry(
  seq: number,
  nodeId: string,
  phase: TraceEntry['phase'],
  port: string | null,
  reason: string,
  extra: {
    workflowPath?: string[];
    findings?: Record<string, JsonValue>;
    attempt?: number;
    source?: 'core' | 'plugin';
    changes?: TraceChanges;
  } = {},
): TraceEntry {
  return {
    seq,
    attempt: extra.attempt ?? 1,
    nodeId,
    workflowPath: extra.workflowPath ?? [],
    phase,
    port,
    reason,
    findings: extra.findings ?? {},
    startedAt: at(seq),
    endedAt: at(seq),
    ...(extra.source ? { source: extra.source } : {}),
    ...(extra.changes ? { changes: extra.changes } : {}),
  };
}

/** What a step that changed nothing records (`TraceEntry.changes`). */
export const NO_CHANGES: TraceChanges = {
  dropped: [],
  added: [],
  converted: [],
  defaults: [],
  reordered: false,
  other: false,
};

const sub = { workflowPath: ['run-a'] };

/** in → vi (pass) → run-a [start → keep → sdt → rt → end] → ca → sg → ro-a */
export const PATH: WalkStep[] = [
  { workflowPath: [], nodeId: 'in', port: 'file' },
  { workflowPath: [], nodeId: 'vi', port: 'pass' },
  { workflowPath: [], nodeId: 'run-a', port: 'file' },
  { workflowPath: ['run-a'], nodeId: 'start', port: 'file' },
  { workflowPath: ['run-a'], nodeId: 'keep', port: 'file' },
  { workflowPath: ['run-a'], nodeId: 'sdt', port: 'file' },
  { workflowPath: ['run-a'], nodeId: 'rt', port: 'file' },
  { workflowPath: ['run-a'], nodeId: 'end', port: 'file' },
  { workflowPath: [], nodeId: 'ca', port: 'file' },
  { workflowPath: [], nodeId: 'sg', port: 'pass' },
  { workflowPath: [], nodeId: 'ro-a', port: 'file' },
];

export const TRACE: TraceEntry[] = [
  entry(1, 'in', 'pass', 'file', 'start: Manual input'),
  entry(2, 'vi', 'decide', 'pass', 'already HEVC ≤ 8 Mb/s', { findings: { codec: 'hevc' } }),
  entry(3, 'run-a', 'pass', 'file', 'enters sub-workflow Language cleanup v3'),
  entry(4, 'start', 'pass', 'file', 'start', sub),
  entry(5, 'end', 'pass', 'file', 'returns', sub),
  entry(6, 'keep', 'build', 'file', 'kept en, de, tr, original, untagged', {
    ...sub,
    changes: {
      ...NO_CHANGES,
      dropped: [{ index: 3, type: 'audio', codec: 'aac', language: 'fra', forced: false }],
    },
  }),
  entry(7, 'sdt', 'build', 'file', 'audio English (was Turkish)', sub),
  entry(8, 'rt', 'build', 'file', 'English then German first', sub),
  entry(9, 'ca', 'build', 'file', 'cover kept', { changes: NO_CHANGES }),
  entry(10, 'sg', 'finish', 'pass', 'this file: −33%, passes'),
  entry(11, 'ro-a', 'finish', 'file', 'original → recycle folder'),
];

const subB = { workflowPath: ['run-b'] };

/** The else branch: in → vi (else) → ev → run-b [start → keep → sdt → rt → end] → ro-b */
export const ELSE_PATH: WalkStep[] = [
  { workflowPath: [], nodeId: 'in', port: 'file' },
  { workflowPath: [], nodeId: 'vi', port: 'else' },
  { workflowPath: [], nodeId: 'ev', port: 'file' },
  { workflowPath: [], nodeId: 'run-b', port: 'file' },
  { workflowPath: ['run-b'], nodeId: 'start', port: 'file' },
  { workflowPath: ['run-b'], nodeId: 'keep', port: 'file' },
  { workflowPath: ['run-b'], nodeId: 'sdt', port: 'file' },
  { workflowPath: ['run-b'], nodeId: 'rt', port: 'file' },
  { workflowPath: ['run-b'], nodeId: 'end', port: 'file' },
  { workflowPath: [], nodeId: 'ro-b', port: 'file' },
];

/** The else branch as the engine traces it, built up to the sub-workflow's last action. */
export const ELSE_TRACE: TraceEntry[] = [
  entry(1, 'in', 'pass', 'file', 'start: Manual input'),
  entry(2, 'vi', 'decide', 'else', 'video is h264 360p, wanted hevc → else'),
  entry(3, 'run-b', 'pass', 'file', 'enters sub-workflow Language cleanup v3'),
  entry(4, 'start', 'pass', 'file', 'start', subB),
  entry(5, 'end', 'pass', 'file', 'returns', subB),
  entry(6, 'ev', 'build', 'file', 'video h264 → hevc'),
  entry(7, 'keep', 'build', 'file', 'kept en, de', subB),
  entry(8, 'sdt', 'build', 'file', 'default audio: en (#1)', subB),
  entry(9, 'rt', 'build', 'file', 'audio: en, de', subB),
  entry(10, 'ro-b', 'finish', 'file', 'original → recycle folder'),
];

/** The same job while it runs: the build has reached `ca` (entries 1–9). */
export const RUNNING_TRACE: TraceEntry[] = TRACE.slice(0, 9);

export const COMMAND =
  'ffmpeg -i "Tigger and Pooh S01E01.mkv" -map 0:v:0 -map 0:a:0 -c copy "Tigger and Pooh S01E01.mkv.tmp"';

/** A finished job (`done`, original in the recycle folder). */
export function jobDetail(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'j1',
    runId: 'r1',
    state: 'done',
    paused: false,
    lane: null,
    attempt: 1,
    encodedOn: null,
    failedGpus: [],
    priority: 0,
    heldByRunHours: null,
    dryRun: false,
    testEncode: false,
    testOutput: null,
    testOutputNote: null,
    fileName: 'Tigger and Pooh S01E01.mkv',
    filePath: '/media/Shows/Tigger and Pooh/Tigger and Pooh S01E01.mkv',
    libraryId: 'l1',
    libraryName: 'Shows',
    workflowId: 'w1',
    workflowVersion: 7,
    workflowName: 'TV cleanup',
    progress: null,
    queuedAt: at(0),
    startedAt: at(0),
    finishedAt: at(30),
    reason: null,
    problems: [],
    estimatedBytes: null,
    planSummary: null,
    dependsOnSize: null,
    trace: TRACE,
    result: {
      outcome: 'done',
      beforeBytes: 2_410_000_000,
      afterBytes: 1_620_000_000,
      estimatedBytes: null,
      command: COMMAND,
      replacedTo: 'recycle',
      warnings: [],
      problems: [],
    },
    probe: null,
    outputProbe: null,
    graph: traceMain(),
    plan: null,
    path: PATH,
    ...over,
  };
}

/** The same job while it builds at `ca`. */
export function runningJobDetail(over: Partial<JobDetail> = {}): JobDetail {
  return jobDetail({
    state: 'building',
    lane: null,
    finishedAt: null,
    trace: RUNNING_TRACE,
    result: null,
    ...over,
  });
}
