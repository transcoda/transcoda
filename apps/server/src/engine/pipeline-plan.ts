// What prepare plans from a built model: the lane and encode slots a job fits, the per-stream
// plan the job screens show, the size estimate, and whether a size gate decides the outcome.
import type { AnyFinishAction, BuildModel, ProbeResult, StreamPlan } from '@transcoda/sdk';
import {
  isPicture,
  type JobPlan,
  type Lane,
  normalizeLanguage,
  RENDER_TYPE,
  sameLanguage,
  type WorkflowGraph,
} from '@transcoda/shared';
import type { Database } from '../db/open.ts';
import { recentRatios } from '../db/repos/jobs.ts';
import {
  containerCanHold,
  diffFromProbe,
  extraInputOf,
  isExtraStream,
  isIdentity,
  isMkvCover,
  kept,
  outputOrder,
} from './build-model.ts';
import { yuv420Depth } from './render.ts';
import type { SlotFit } from './scheduler.ts';
import type { DecidedPath } from './walk.ts';

/** Results whose after/before ratio feeds a dry run's estimate. */
export const ESTIMATE_HISTORY = 20;

/** `encode` iff any kept video stream (not a picture) is converted; everything else is quick. */
export function laneFor(model: BuildModel, probe: ProbeResult): Lane {
  return kept(model).some((s) => s.type === 'video' && s.mode === 'convert' && !pictureOf(s, probe))
    ? 'encode'
    : 'quick';
}

/**
 * The encode slots a job fits, from its kept video streams in convert mode: a named NVENC
 * encoder needs an NVIDIA slot, a named QSV encoder an Intel one; else auto hardware encoders go
 * on any GPU, and software encodes on any slot.
 */
export function slotFitOf(model: BuildModel, auto: ReadonlySet<number>): SlotFit {
  const video = [...model.streams.entries()].filter(
    ([, s]) => s.keep && s.type === 'video' && s.mode === 'convert',
  );
  const named = video.filter(([i]) => !auto.has(i)).map(([, s]) => s.encoder ?? '');
  if (named.some((e) => e.endsWith('_nvenc'))) return 'nvidia';
  if (named.some((e) => e.endsWith('_qsv'))) return 'intel';
  const hardware = ([i, s]: [number, StreamPlan]) =>
    auto.has(i) && /_(nvenc|qsv)$/.test(s.encoder ?? '');
  return video.some(hardware) ? 'gpu' : 'software';
}

/** A planned stream is a picture when its source is one (isPicture); an added one when flagged. */
export function pictureOf(s: StreamPlan, probe: ProbeResult): boolean {
  const src = probe.streams.find((p) => p.index === s.sourceIndex);
  return src ? isPicture(src, probe.streams) : s.attachedPic;
}

/** Median after/before ratio of the workflow's recent `done` results × `beforeBytes`; null without. */
export function estimateBytes(
  db: Database,
  workflowId: string,
  beforeBytes: number,
): number | null {
  const ratios = recentRatios(db, workflowId, ESTIMATE_HISTORY).sort((a, b) => a - b);
  if (ratios.length === 0) return null;
  const mid = Math.floor(ratios.length / 2);
  const median =
    ratios.length % 2 === 1
      ? (ratios[mid] as number)
      : ((ratios[mid - 1] as number) + (ratios[mid] as number)) / 2;
  return Math.round(median * beforeBytes);
}

function actionOf(s: StreamPlan): 'keep' | 'drop' | 'convert' {
  if (!s.keep) return 'drop';
  return s.mode === 'convert' && s.type !== 'data' ? 'convert' : 'keep';
}

/**
 * The model per stream for the job screens: one entry per probe stream (dropped ones `drop`), then
 * one per stream the model adds (a second plan for the same source, e.g. an added audio track).
 * Notes come from diffFromProbe's per-stream lines.
 */
export function planOf(
  model: BuildModel,
  probe: ProbeResult,
  originalLanguage: string | null,
  /** Extra notes per stream (normalizeDefaults), appended to the diff's. */
  extraNotes: ReadonlyMap<StreamPlan, string> = new Map(),
): JobPlan {
  const lines = diffFromProbe(model, probe);
  const notesFor = (type: string, index: number): string[] => {
    const prefix = `${type} #${index}: `;
    return lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
  };
  const dropNote = (type: string, index: number): string => {
    const line = lines.find(
      (l) => l === `drop ${type} #${index}` || l.startsWith(`drop ${type} #${index} (`),
    );
    const m = line ? /\((.*)\)$/.exec(line) : null;
    return m?.[1] ?? '';
  };
  const isOriginal = (language: string | null): boolean =>
    originalLanguage !== null && sameLanguage(language, originalLanguage);
  const streams: JobPlan['streams'] = [];
  const keptOrder = kept(model);
  for (const p of probe.streams) {
    const plans = model.streams.filter((s) => s.sourceIndex === p.index);
    const [first, ...added] = plans;
    const notes = notesFor(p.type, p.index);
    const keptPlans = keptOrder.filter((s) => s.sourceIndex === p.index);
    const diffNoteOf = (s: StreamPlan): string => {
      if (!s.keep) return dropNote(p.type, p.index);
      if (notes.length === keptPlans.length) return notes[keptPlans.indexOf(s)] ?? '';
      return s === keptPlans[0] ? (notes[0] ?? '') : '';
    };
    const noteOf = (s: StreamPlan): string =>
      [diffNoteOf(s), extraNotes.get(s) ?? ''].filter((n) => n !== '').join('; ');
    if (!first) {
      streams.push({
        index: p.index,
        type: p.type,
        codec: p.codec,
        language: p.language,
        title: p.title,
        isOriginalLanguage: isOriginal(p.language),
        default: { before: p.default, after: false },
        forced: p.forced,
        action: 'drop',
        note: dropNote(p.type, p.index),
      });
      continue;
    }
    for (const [n, s] of [first, ...added].entries()) {
      const language = s.keep ? s.language : p.language;
      const note = noteOf(s);
      streams.push({
        index: p.index,
        type: p.type,
        codec: s.keep ? s.codec : p.codec,
        language,
        title: s.keep ? s.title : p.title,
        isOriginalLanguage: isOriginal(language),
        default: { before: n === 0 ? p.default : false, after: s.keep ? s.default : false },
        forced: s.keep ? s.forced : p.forced,
        action: actionOf(s),
        note: n === 0 ? note : note === '' ? 'added' : `added: ${note}`,
      });
    }
  }
  const sidecars = sidecarsOf(model);
  return {
    container: { from: probe.container, to: model.container },
    streams,
    ...(sidecars.length > 0 ? { sidecars } : {}),
    rewrite: !isIdentity(model, probe),
    output: outputOrder(model)
      .filter((s) => !isMkvCover(model, s))
      .map((s) => outputTrack(s, probe)),
  };
}

/**
 * A kept stream as the plan's output track, with its source stream's probe index (null for a
 * track from an extra input file). A video track's bit depth comes from the pixel format
 * it is encoded to, else the source's (a copy, or an encode that keeps the source's format); an
 * audio track's channels from the encode, else the source's. Left out when unknown.
 */
function outputTrack(s: StreamPlan, probe: ProbeResult): NonNullable<JobPlan['output']>[number] {
  const source = s.input ? undefined : probe.streams.find((p) => p.index === s.sourceIndex);
  const track = { type: s.type, codec: s.codec, sourceIndex: s.input ? null : s.sourceIndex };
  if (s.type === 'video') {
    const bitDepth =
      s.pixelFormat !== null ? yuv420Depth(s.pixelFormat) : (source?.bitDepth ?? null);
    return bitDepth === null ? track : { ...track, bitDepth };
  }
  if (s.type === 'audio') {
    const channels = s.channels ?? source?.channels ?? null;
    return channels === null ? track : { ...track, channels };
  }
  return track;
}

/** One entry per extra input file (input order): embedded, or dropped with the reason. */
function sidecarsOf(model: BuildModel): NonNullable<JobPlan['sidecars']> {
  return model.streams
    .filter(isExtraStream)
    .sort((a, b) => (a.input ?? 0) - (b.input ?? 0) || a.order - b.order)
    .flatMap((s) => {
      const input = extraInputOf(model, s);
      if (!input) return [];
      const { file, language, forced, sdh } = input.label;
      const held = containerCanHold(model.container, {
        type: s.type,
        codec: input.codec,
      });
      return [
        {
          file,
          language,
          forced,
          sdh,
          codec: s.codec,
          action: s.keep ? ('embed' as const) : ('drop' as const),
          note: s.keep || held ? '' : "container can't hold it",
        },
      ];
    });
}

/** The first `language` value a data node produced (its findings), normalised; null when unknown. */
export function originalLanguageOf(decided: DecidedPath): string | null {
  for (const values of decided.data.values()) {
    const v = values.language;
    if (typeof v === 'string' && v !== 'unknown') {
      const lang = normalizeLanguage(v);
      if (lang !== null) return lang;
    }
  }
  return null;
}

/** The top-level Render on `path` that runs (not bypassed); null when the path has none. */
export function renderOnPath(
  graph: WorkflowGraph,
  path: { workflowPath: string[]; nodeId: string }[],
) {
  for (const s of path) {
    if (s.workflowPath.length > 0) continue;
    const n = graph.nodes.find((x) => x.id === s.nodeId);
    if (n?.type === RENDER_TYPE && n.bypassed !== true) return n.id;
  }
  return null;
}

/**
 * Whether a size gate decides the outcome: the strictest minimum saving of the size gates before
 * the first replace or move-copy in the walked actions; null without a write or without such a
 * gate. A gate on a branch not taken or a bypassed gate adds no action, so it never counts.
 */
export function sizeGateDecides(
  actions: readonly AnyFinishAction[],
): { minSavingPercent: number } | null {
  let min: number | null = null;
  for (const a of actions) {
    if (a.kind === 'replace' || a.kind === 'move-copy') {
      return min === null ? null : { minSavingPercent: min };
    }
    if (a.kind === 'size-gate') min = Math.max(min ?? a.minSavingPercent, a.minSavingPercent);
  }
  return null;
}
