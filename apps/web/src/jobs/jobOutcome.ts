// What the job page's Result card and header say: a failure's cause in plain words, the card's
// tone (the state chip's colour, as a softly tinted icon circle) and the one time line.
import type { JobState } from '@transcoda/shared';
import { fmtDuration, fmtStamp } from '../lib/time.ts';
import { sentence, type Verdict } from './jobText.ts';

/** The Result card's tone: the chip system's colours (lime, neutral, red, amber). */
export type ResultTone = 'ok' | 'neutral' | 'error' | 'warning';

export const RESULT_TONE: Record<Verdict, ResultTone> = {
  replaced: 'ok',
  running: 'ok',
  failed: 'error',
  attention: 'warning',
  damaged: 'warning',
  dry: 'warning',
  kept: 'neutral',
  noop: 'neutral',
  skipped: 'neutral',
  cancelled: 'neutral',
  already: 'neutral',
  queued: 'neutral',
};

export interface FailureCause {
  /** The cause in plain words ("The file could not be read"). */
  headline: string;
  /** What exactly went wrong, as a sentence; null when the headline says it all. */
  text: string | null;
}

/** `[matroska,webm @ 0x90903c000] ` before an ffmpeg/ffprobe message. */
const DEMUXER_PREFIX = /^\[[^\]]* @ 0x[0-9a-f]+\]\s*/i;

/** ffprobe's own messages, said as what they mean for the file. */
const PROBE_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/^invalid data found when processing input$/i, 'ffprobe found invalid data in the file'],
  [/^no such file or directory$/i, 'the file is no longer there'],
  [/^permission denied$/i, "Transcoda isn't allowed to read the file"],
  [/^ffprobe was not found$/i, 'ffprobe was not found on the server'],
];

/**
 * ffprobe's error as one clause: the last message in plain words, earlier ones in brackets
 * ("ffprobe found invalid data in the file (EBML header parsing failed)"). Older reasons carry
 * node's "Command failed: <command line>" and the file's path; both are left out here (the raw
 * error stays available beside the cause).
 */
function probeClause(detail: string): string {
  const messages = detail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('Command failed:'))
    .map((l) =>
      l
        .replace(DEMUXER_PREFIX, '')
        .replace(/^\/\S*:\s+/, '')
        .trim(),
    )
    .filter((l) => l !== '');
  const last = messages.at(-1);
  if (last === undefined) return 'ffprobe could not read it';
  const words = PROBE_WORDS.find(([re]) => re.test(last))?.[1] ?? last;
  const extra = messages.slice(0, -1);
  return extra.length > 0 ? `${words} (${extra.join('; ')})` : words;
}

/**
 * Reason prefixes the engine writes, with the cause each one means. The text after the prefix is
 * the detail; `whole` keeps the full reason as the detail (its first words are the message).
 */
const CAUSES: ReadonlyArray<{ re: RegExp; headline: string; whole?: boolean }> = [
  { re: /^cannot read the file:\s*/i, headline: 'The file could not be read' },
  { re: /^workflow missing$/i, headline: 'The workflow no longer exists' },
  { re: /^workflow invalid:\s*/i, headline: "The workflow version can't run" },
  { re: /^render:\s*/i, headline: 'The workflow could not be applied to this file' },
  { re: /^verify:\s*/i, headline: 'The encoded file did not pass the checks' },
  { re: /^(encode|ffmpeg) /i, headline: 'The encode failed', whole: true },
  {
    re: /^(replace|file moved before the replace):\s*/i,
    headline: 'The original could not be replaced',
  },
  { re: /^move-copy:\s*/i, headline: 'The result could not be moved or copied' },
  {
    re: /^file changed during processing$/i,
    headline: 'The file changed while it was being processed',
  },
  { re: /^library root unavailable:\s*/i, headline: 'The library folder was not available' },
  { re: /^interrupted;?\s*/i, headline: 'The job was interrupted' },
  { re: /^internal error:\s*/i, headline: 'Transcoda hit an internal error' },
];

/** A capital first letter, except for the tools' own lower-case names ("ffprobe found …"). */
const capital = (s: string) => (/^(ffmpeg|ffprobe)\b/.test(s) ? s : sentence(s));

/** "probe failed" → "Probe failed.": a detail as a sentence with its full stop. */
const asSentence = (s: string) => capital(s).replace(/\.?$/, '.');

/**
 * A failed job's cause in plain words where the reason lets the app tell (a probe failure is "The
 * file could not be read", with ffprobe's message as a sentence after it); otherwise "The job
 * failed" with the engine's reason as the sentence. The page keeps the raw reason available.
 */
export function failureCause(reason: string | null): FailureCause {
  const raw = reason?.trim() ?? '';
  if (raw === '') return { headline: 'The job failed', text: null };
  const probe = /^probe failed:\s*/i.exec(raw);
  if (probe) {
    const clause = probeClause(raw.slice(probe[0].length));
    return {
      headline: 'The file could not be read',
      text: `${capital(clause)}, so the workflow never started.`,
    };
  }
  for (const { re, headline, whole } of CAUSES) {
    const m = re.exec(raw);
    if (!m) continue;
    const detail = (whole ? raw : raw.slice(m[0].length)).trim();
    return { headline, text: detail === '' ? null : asSentence(detail) };
  }
  return { headline: 'The job failed', text: asSentence(raw) };
}

/**
 * The header's one time: "Queued 8 min ago" while queued, "Started 2 min ago" while running,
 * "Finished Oct 23, 06:29 · took 3 s" once done (convention 13: relative under a day).
 */
export function jobWhenLine(
  job: { state: JobState; queuedAt: string; startedAt: string | null; finishedAt: string | null },
  final: boolean,
  now: Date = new Date(),
): string {
  const at = (iso: string) => fmtStamp(iso, { time: true, now });
  if (final && job.finishedAt) {
    const took =
      job.startedAt !== null
        ? ` · took ${fmtDuration(Date.parse(job.finishedAt) - Date.parse(job.startedAt))}`
        : '';
    return `Finished ${at(job.finishedAt)}${took}`;
  }
  if (job.startedAt) return `Started ${at(job.startedAt)}`;
  return `Queued ${at(job.queuedAt)}`;
}
