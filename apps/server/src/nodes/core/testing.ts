// Shared helpers for the core node hook tests (conditions, actions, finish): probes, decide and
// build contexts, and calls into a node's decide, build and finish hooks.
import { readFileSync } from 'node:fs';
import {
  type AnyNodeDefinition,
  type BuildContext,
  type BuildModel,
  corePluginContext,
  type DataValue,
  type DecideContext,
  type FinishContext,
  type ProbeResult,
  type StreamPlan,
} from '@transcoda/sdk';
import { parseProbe } from '../../engine/media/probe.ts';
import { modelFromProbe } from '../../engine/model/model.ts';
import { capsOf, fileOf } from '../../engine/testing/builders.ts';

export const otter: ProbeResult = parseProbe(
  JSON.parse(
    readFileSync(
      new URL('../../engine/media/fixtures/ffprobe-otter-finch.json', import.meta.url),
      'utf8',
    ),
  ),
);

export const NOW = Date.parse('2026-10-16T12:00:00.000Z');
export const DAY = 86_400_000;

export function decideCtx(
  probe: ProbeResult,
  opts: { data?: Record<string, DataValue>; path?: string; mtime?: string } = {},
): DecideContext {
  return {
    probe,
    file: { ...fileOf(opts.path ?? '/media/movie.mkv', probe.sizeBytes), ...pick(opts.mtime) },
    data: opts.data ?? { language: 'eng' },
    capabilities: capsOf(['libx265', 'aac']),
    log: () => {},
    plugin: corePluginContext(),
    now: NOW,
  };
}

function pick(mtime: string | undefined): { mtime?: string } {
  return mtime === undefined ? {} : { mtime };
}

export function buildCtx(
  probe: ProbeResult,
  opts: {
    model?: BuildModel;
    data?: Record<string, DataValue>;
    encoders?: string[];
  } = {},
): BuildContext {
  const { now: _now, ...base } = decideCtx(
    probe,
    opts.data === undefined ? {} : { data: opts.data },
  );
  return {
    ...base,
    capabilities: capsOf(opts.encoders ?? ['libx265', 'aac']),
    model: opts.model ?? modelFromProbe(probe),
  };
}

export function decide(
  def: AnyNodeDefinition,
  ctx: DecideContext,
  raw: Record<string, unknown> = {},
) {
  if (!def.decide) throw new Error(`${def.type} has no decide`);
  return def.decide(ctx, def.settings.parse(raw));
}

export function build(
  def: AnyNodeDefinition,
  ctx: BuildContext,
  raw: Record<string, unknown> = {},
) {
  if (!def.build) throw new Error(`${def.type} has no build`);
  return def.build(ctx, def.settings.parse(raw));
}

export function finish(
  def: AnyNodeDefinition,
  ctx: FinishContext,
  raw: Record<string, unknown> = {},
) {
  if (!def.finish) throw new Error(`${def.type} has no finish`);
  return def.finish(ctx, def.settings.parse(raw));
}

export const indices = (streams: StreamPlan[]) => streams.map((s) => s.sourceIndex);
export const languages = (streams: StreamPlan[]) => streams.map((s) => s.language);
export const byIndex = (model: BuildModel, i: number) => {
  const s = model.streams.find((p) => p.sourceIndex === i);
  if (!s) throw new Error(`no stream ${i}`);
  return s;
};
