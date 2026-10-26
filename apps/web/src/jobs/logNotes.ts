// Screen 06b "Notes from ffmpeg": the warnings ffmpeg prints that are known, in plain words, tagged
// warning or expected. Pure over the log text; anything not known stays in the raw output only.
import type { ProbeSummary } from '@transcoda/shared';

export interface FfmpegNote {
  key: string;
  tag: 'warning' | 'expected';
  title: string;
  text: string;
}

/** libnuma (via libx265) in a container without CAP_SYS_NICE: once per thread or frame (#43). */
const NUMA = /^set_mempolicy: Operation not permitted\s*$/;
const PGS =
  /Could not find codec parameters for stream (\d+) \(Subtitle: hdmv_pgs_subtitle\b.*unspecified size/;
const PROBE_SIZE = /Consider increasing the value for the 'analyzeduration'.*'probesize'/;
const PIXEL_FORMAT =
  /Incompatible pixel format '([^']+)' for codec '([^']+)', auto-selecting format '([^']+)'/;

/** The server's mark on a line it said once for many (`jobs.log`): `<line> [transcoda: <n> times]`. */
const REPEATED = /^(.*) \[transcoda: (at least )?(\d+) times\]$/;

/** The log's lines, each with how many times it came (the server's marks read back). */
function lines(log: string): { text: string; times: number; atLeast: boolean }[] {
  const all = log.split(/\r?\n/);
  if (all.at(-1) === '') all.pop();
  return all.map((line) => {
    const m = REPEATED.exec(line);
    return m?.[1] !== undefined && m[3]
      ? { text: m[1], times: Number(m[3]), atLeast: m[2] !== undefined }
      : { text: line, times: 1, atLeast: false };
  });
}

/** "Subtitle #2" (its place among the subtitles, from the probe), else "Subtitle stream 3". */
function subtitleName(index: number, probe: ProbeSummary | null): string {
  const subs = probe?.streams.filter((s) => s.type === 'subtitle') ?? [];
  const at = subs.findIndex((s) => s.index === index);
  return at >= 0 ? `Subtitle #${at + 1}` : `Subtitle stream ${index}`;
}

const tenBit = (format: string) => /(10|p010)/.test(format);

/** The known warnings in `log`, once each, in the order they first appear. */
export function ffmpegNotes(log: string, probe: ProbeSummary | null): FfmpegNote[] {
  const notes = new Map<string, FfmpegNote>();
  let numa = 0;
  let numaAtLeast = false;
  let probeHint = false;
  for (const { text: line, times, atLeast } of lines(log)) {
    if (NUMA.test(line)) {
      numa += times;
      numaAtLeast ||= atLeast;
      if (!notes.has('numa')) {
        notes.set('numa', {
          key: 'numa',
          tag: 'expected',
          title: 'x265 memory placement',
          text: '',
        });
      }
      continue;
    }
    const pgs = PGS.exec(line);
    if (pgs?.[1]) {
      const index = Number(pgs[1]);
      notes.set(`pgs-${index}`, {
        key: `pgs-${index}`,
        tag: 'warning',
        title: `${subtitleName(index, probe)} (PGS image subtitle)`,
        text: "ffmpeg couldn't read its size in the quick scan. Copying it works anyway; it only matters if a job fails on this file.",
      });
      continue;
    }
    if (PROBE_SIZE.test(line)) {
      probeHint = true;
      continue;
    }
    const pix = PIXEL_FORMAT.exec(line);
    if (pix?.[1] && pix[2] && pix[3]) {
      const [, from, codec, to] = pix;
      const expected = codec.endsWith('_nvenc') && to === 'p010le' && tenBit(from);
      notes.set(`pix-${codec}`, {
        key: `pix-${codec}`,
        tag: expected ? 'expected' : 'warning',
        title: 'Encode video pixel format',
        text: expected
          ? 'The 10-bit source is passed to NVENC as p010le. This is normal for NVIDIA hardware encoding and keeps 10-bit.'
          : `${codec} can't take ${from}, so ffmpeg converted it to ${to}. Check the result if colours or bit depth matter.`,
      });
    }
  }
  const numaNote = notes.get('numa');
  if (numaNote) {
    const often = `${numaAtLeast ? 'at least ' : ''}${numa === 1 && !numaAtLeast ? 'once' : `${numa.toLocaleString('en')} times`}`;
    numaNote.text = `libx265 asks to place its memory per processor and isn't allowed to here (containers often forbid it), so ffmpeg printed this ${often}. It's harmless: the encode isn't affected.`;
  }
  // The probe-size hint follows the warning it explains; alone, it is a card of its own.
  if (probeHint && ![...notes.keys()].some((k) => k.startsWith('pgs-'))) {
    notes.set('probe-size', {
      key: 'probe-size',
      tag: 'warning',
      title: 'File scan',
      text: "ffmpeg's quick scan didn't see everything in this file. Copying usually works anyway; it only matters if a job fails on this file.",
    });
  }
  return [...notes.values()];
}

/** How many lines ffmpeg wrote in this (tail of the) log, each repeat counted. */
export function logLineCount(log: string): number {
  return lines(log).reduce((n, l) => n + l.times, 0);
}

/**
 * The log as the raw output shows it: the set_mempolicy flood as one line where it starts (it is
 * explained in a note), and a line repeated in a row once with how many times.
 */
export function shownLog(log: string): string {
  const all = lines(log);
  const floods = all.filter((l) => NUMA.test(l.text));
  const numa = floods.reduce((n, l) => n + l.times, 0);
  const atLeast = floods.some((l) => l.atLeast) ? 'at least ' : '';
  const out: string[] = [];
  let numaShown = false;
  let last: string | null = null;
  let repeats = 0;
  const flush = () => {
    if (last !== null) {
      out.push(repeats > 1 ? `${last} [${repeats.toLocaleString('en')} times in a row]` : last);
    }
    last = null;
    repeats = 0;
  };
  for (const { text: line, times } of all) {
    if (NUMA.test(line)) {
      if (numaShown) continue;
      numaShown = true;
      flush();
      out.push(
        numa > 1 || atLeast
          ? `${line.trim()} [${atLeast}${numa.toLocaleString('en')} times, see the note above]`
          : line,
      );
      continue;
    }
    if (line === last) {
      repeats += times;
      continue;
    }
    flush();
    last = line;
    repeats = times;
  }
  flush();
  return out.join('\n');
}
