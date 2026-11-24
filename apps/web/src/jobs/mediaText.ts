// Text for a job's media info: one title for buttons, dialogs and the page title, the muted line
// under it, and the two-line size result.

import type { Job, JobMedia } from '@transcoda/contract';
import { fmtBytes } from '../lib/bytes.ts';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `S01E17`; season and episode zero-padded to two digits; null unless both are known. */
export function episodeCode(media: Pick<JobMedia, 'season' | 'episode'>): string | null {
  if (media.season === null || media.episode === null) return null;
  return `S${pad2(media.season)}E${pad2(media.episode)}`;
}

/** One name for buttons, dialogs, toasts and the page title. */
export function jobTitle(job: Pick<Job, 'media'>): string {
  const { media } = job;
  if (media.kind === 'episode') {
    const code = episodeCode(media);
    return code ? `${media.title} ${code}` : media.title;
  }
  if (media.kind === 'movie' && media.year !== null) return `${media.title} (${media.year})`;
  return media.title;
}

/** The muted line under a title: `code` is shown bold; null parts are left out. */
export function mediaSub(media: JobMedia): { code: string | null; text: string | null } {
  if (media.kind === 'episode') {
    return { code: episodeCode(media), text: media.episodeTitle };
  }
  if (media.kind === 'movie' && media.year !== null)
    return { code: null, text: String(media.year) };
  return { code: null, text: null };
}

/** 9.75 -> "9.8", 57.04 -> "57", 0 -> "0". */
function fmtPct(pct: number): string {
  return pct < 10
    ? String(Number((Math.round(pct * 10) / 10).toFixed(1)))
    : String(Math.round(pct));
}

/** The two-line size result; null when the row should show `detailLine` instead. */
export function resultLines(
  job: Job,
): { sizes: string; change: string; tone: 'saved' | 'grew' } | null {
  if (job.dryRun) return null;
  if (job.state !== 'done' && job.state !== 'kept_original') return null;
  const r = job.result;
  if (!r || r.restored) return null;
  const { beforeBytes: before, afterBytes: after } = r;
  if (before === null || after === null || !(before > 0)) return null;
  const diff = before - after;
  const pct = (Math.abs(diff) / before) * 100;
  const grew = diff < 0;
  return {
    sizes: `${fmtBytes(before)} → ${fmtBytes(after)}`,
    change: `${grew ? 'grew' : 'saved'} ${fmtPct(pct)}% · ${fmtBytes(Math.abs(diff))}`,
    tone: grew ? 'grew' : 'saved',
  };
}
