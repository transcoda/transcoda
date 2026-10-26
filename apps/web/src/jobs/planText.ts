import { type JobPlan, LANGUAGES, type ProbeSummary } from '@transcoda/shared';
import { fmtBytes } from '../lib/bytes.ts';
import { fmtKbps } from '../lib/rate.ts';

// The words of the dry-run plan (screen 06), pure over the engine's JobPlan and ProbeSummary.

export type PlanStream = JobPlan['streams'][number];
export type LanguageGroup = {
  language: string | null;
  /** The English name, "Untagged" for no tag, or the code when the table does not know it. */
  name: string;
  /** The file's original language (the plan's `isOriginalLanguage`). */
  original: boolean;
  streams: PlanStream[];
};

const NAMES = new Map<string, string>();
for (const l of LANGUAGES) {
  NAMES.set(l.t, l.name);
  if (l.b) NAMES.set(l.b, l.name);
  if (l.one) NAMES.set(l.one, l.name);
}

export function languageNameOf(code: string | null): string {
  if (code === null) return 'Untagged';
  return NAMES.get(code.toLowerCase()) ?? code;
}

const kept = (s: PlanStream) => s.action !== 'drop';

/**
 * The streams of one type by language: languages with a kept track first, in stream order, then
 * the dropped ones in stream order.
 */
export function groupByLanguage(
  streams: JobPlan['streams'],
  type: 'audio' | 'subtitle',
): LanguageGroup[] {
  const groups = new Map<string, LanguageGroup>();
  for (const s of streams) {
    if (s.type !== type) continue;
    const key = s.language ?? '';
    let g = groups.get(key);
    if (!g) {
      g = { language: s.language, name: languageNameOf(s.language), original: false, streams: [] };
      groups.set(key, g);
    }
    g.streams.push(s);
    if (s.isOriginalLanguage) g.original = true;
  }
  const all = [...groups.values()];
  return [...all.filter((g) => g.streams.some(kept)), ...all.filter((g) => !g.streams.some(kept))];
}

/**
 * The table's rows and the folded rest: every language with a kept track, plus dropped languages
 * that lose the default flag (the change worth a row); the other dropped tracks fold into the
 * drop line.
 */
export function shownDrops(
  streams: JobPlan['streams'],
  type: 'audio' | 'subtitle',
): { rows: LanguageGroup[]; folded: PlanStream[] } {
  const rows: LanguageGroup[] = [];
  const folded: PlanStream[] = [];
  for (const g of groupByLanguage(streams, type)) {
    if (g.streams.some(kept) || g.streams.some((s) => s.default.before)) rows.push(g);
    else folded.push(...g.streams);
  }
  return { rows, folded };
}

/** "3 of 20 tracks kept" (audio and subtitles alike). */
export function keptSummary(streams: JobPlan['streams'], type: 'audio' | 'subtitle'): string {
  const ofType = streams.filter((s) => s.type === type);
  return `${ofType.filter(kept).length} of ${ofType.length} tracks kept`;
}

const SHOWN_NAMES = 4;

/** "Drop 16 more in 14 languages: French, Spanish, Italian, Portuguese …"; null when none. */
export function dropLine(dropped: JobPlan['streams']): string | null {
  if (dropped.length === 0) return null;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const s of dropped) {
    const key = s.language ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(languageNameOf(s.language));
  }
  const langs = `${names.length} language${names.length === 1 ? '' : 's'}`;
  const more = names.length > SHOWN_NAMES ? ' …' : '';
  return `Drop ${dropped.length} more in ${langs}: ${names.slice(0, SHOWN_NAMES).join(', ')}${more}`;
}

/** "2 of 3 embedded" for the subtitle files table; null when the plan has no sidecars. */
export function sidecarSummary(plan: JobPlan): string | null {
  const all = plan.sidecars ?? [];
  if (all.length === 0) return null;
  return `${all.filter((s) => s.action === 'embed').length} of ${all.length} embedded`;
}

export function wouldDo(plan: JobPlan): 'Rewrite once' | 'Nothing' {
  return plan.rewrite ? 'Rewrite once' : 'Nothing';
}

const TYPE_LETTER: Record<PlanStream['type'], string> = {
  video: 'v',
  audio: 'a',
  subtitle: 's',
  attachment: 't',
  data: 'd',
};

const LAYOUTS: Record<number, string> = { 1: 'mono', 2: '2.0', 6: '5.1', 8: '7.1' };

/** "6.1 Mb/s", "640 kb/s". */
const fmtBitrate = fmtKbps;

/**
 * "a:2 · AAC 5.1", "v:0 · HEVC 1080p · 6.1 Mb/s", "s:1 · full" / "s:2 · signs and songs". The
 * number counts within the stream's type, as ffmpeg's `0:a:2` does (from the probe; without one,
 * the stream's own index). Channels, height and bitrate come from the probe.
 */
export function trackLabel(s: PlanStream, probe: ProbeSummary | null): string {
  const src = probe?.streams.find((p) => p.index === s.index) ?? null;
  const n =
    src && probe
      ? probe.streams.filter((p) => p.type === s.type && p.index < s.index).length
      : s.index;
  const id = `${TYPE_LETTER[s.type]}:${n}`;
  if (s.type === 'subtitle') return `${id} · ${s.forced ? 'signs and songs' : 'full'}`;
  const parts = [s.codec.toUpperCase()];
  if (s.type === 'audio' && src?.channels) {
    parts.push(LAYOUTS[src.channels] ?? `${src.channels} ch`);
  }
  if (s.type === 'video' && src?.height) parts.push(`${src.height}p`);
  const head = `${id} · ${parts.join(' ')}`;
  return s.type === 'video' && src?.bitrateKbps ? `${head} · ${fmtBitrate(src.bitrateKbps)}` : head;
}

/** "MP4 → MKV · remux" | "MKV" (unchanged). */
export function containerLine(plan: JobPlan): string {
  const from = plan.container.from.toUpperCase();
  const to = plan.container.to.toUpperCase();
  return from === to ? to : `${from} → ${to} · remux`;
}

/** "2.41 → 1.62 GB", "2.41 GB → 790 MB"; one side alone without an estimate; "—" without sizes. */
export function sizeLine(before: number | null, after: number | null): string {
  if (before === null) return after === null ? '—' : fmtBytes(after);
  const b = fmtBytes(before);
  if (after === null) return b;
  const a = fmtBytes(after);
  const unitB = b.split(' ')[1];
  const unitA = a.split(' ')[1];
  return unitA === unitB ? `${b.split(' ')[0]} → ${a}` : `${b} → ${a}`;
}
