// Shared helpers for the core node hooks: language matching, default selection, ordering.
import type { BuildModel, DataValue, StreamPlan } from '@transcoda/sdk';
import { LANGUAGES, normalizeLanguage } from '@transcoda/shared';

/** A hook failure the job reports as its reason (the walker fails the job with the message). */
export class NodeHookError extends Error {
  override name = 'NodeHookError';
}

/** True when the stream's language tag is one of `codes`; both sides are normalised. */
export function matchesLanguage(stream: { language: string | null }, codes: string[]): boolean {
  const language = normalizeLanguage(stream.language);
  return language !== null && codes.some((c) => normalizeLanguage(c) === language);
}

/** The first stream matching the first code in `order` that any stream matches; null when none. */
export function pickDefault<S extends { language: string | null }>(
  streams: S[],
  order: string[],
): S | null {
  for (const code of order) {
    const match = streams.find((s) => matchesLanguage(s, [code]));
    if (match) return match;
  }
  return null;
}

/** Stable sort by position of the language in `order`; unlisted languages after, untagged last. */
export function sortByLanguage<S extends { language: string | null }>(
  streams: S[],
  order: string[],
): S[] {
  const rank = (s: S) => {
    if (normalizeLanguage(s.language) === null) return order.length + 1;
    const i = order.findIndex((code) => matchesLanguage(s, [code]));
    return i === -1 ? order.length : i;
  };
  return streams
    .map((s, i) => ({ s, i, r: rank(s) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.s);
}

/** The original language from the `language` data input, normalised; null when unknown or unset. */
export function originalLanguage(data: Record<string, DataValue>): string | null {
  const value = data.language;
  if (typeof value !== 'string' || value === 'unknown') return null;
  return normalizeLanguage(value);
}

/** A stream's language for reasons: its tag, `und` when untagged. */
export function tag(s: { language: string | null }): string {
  return s.language ?? 'und';
}

const TWO_LETTER: ReadonlyMap<string, string> = new Map(
  LANGUAGES.flatMap((l) => (l.one === null ? [] : [[l.t, l.one] as const])),
);

/**
 * A stream's language in reasons, spelled like the node settings: the two-letter code when the
 * language has one ('eng', 'ger' → 'en', 'de'), else its three-letter code; 'und' when untagged.
 */
export function reasonTag(s: { language: string | null }): string {
  const code = normalizeLanguage(s.language);
  if (code === null) return 'und';
  return TWO_LETTER.get(code) ?? code;
}

/** A list for reasons; `none` when empty. */
export function list(items: string[]): string {
  return items.length > 0 ? items.join(', ') : 'none';
}

type Ref = { sourceIndex: number; input?: number | undefined };

/**
 * A stream in reasons: `#2` for a source stream, the file name for a stream from an extra input
 * (`Show.de.srt`, never `#-1`) when the model is given.
 */
export function ref(s: Ref, model?: BuildModel): string {
  const n = s.input ?? 0;
  const file = n > 0 ? model?.extraInputs?.[n - 1]?.label.file : undefined;
  return file ?? `#${s.sourceIndex}`;
}

/** `#1, #2` for reasons (extra-input streams by file name, see {@link ref}). */
export function refs(streams: Ref[], model?: BuildModel): string {
  return streams.map((s) => ref(s, model)).join(', ');
}

/** A copy of the model whose streams are copies, so a hook can change them in place. */
export function copyModel(model: BuildModel): BuildModel {
  return {
    ...model,
    streams: model.streams.map((s) => ({ ...s, dispositions: [...s.dispositions] })),
    targets: [...model.targets],
    inputArgs: [...model.inputArgs],
    globalArgs: [...model.globalArgs],
  };
}

/**
 * Renumbers `order` so the kept streams follow `arranged` (every kept stream exactly once);
 * dropped streams go after them.
 */
export function setOrder(model: BuildModel, arranged: StreamPlan[]): void {
  arranged.forEach((s, i) => {
    s.order = i;
  });
  let next = arranged.length;
  for (const s of model.streams) if (!arranged.includes(s)) s.order = next++;
}

/** Adds the node's targets to the model's (verify checks the output against all of them). */
export function addTargets(model: BuildModel, targets: BuildModel['targets']): void {
  for (const t of targets) if (!model.targets.includes(t)) model.targets.push(t);
}
