import type { ProbeSummary } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { ffmpegNotes, logLineCount, shownLog } from './logNotes.ts';

const PGS = [
  '[in#0/matroska,webm @ 0x5e5eade59f00] [warning] Could not find codec parameters for stream 3 (Subtitle: hdmv_pgs_subtitle (pgssub)): unspecified size',
  "Consider increasing the value for the 'analyzeduration' (0) and 'probesize' (5000000) options",
];
const NVENC =
  "[hevc_nvenc @ 0x55d0] [warning] Incompatible pixel format 'yuv420p10le' for codec 'hevc_nvenc', auto-selecting format 'p010le'";
const NUMA = 'set_mempolicy: Operation not permitted';

const probe = {
  container: 'mkv',
  durationSeconds: 60,
  sizeBytes: 1,
  bitrateKbps: null,
  streams: [
    { index: 0, type: 'video' },
    { index: 1, type: 'audio' },
    { index: 2, type: 'subtitle' },
    { index: 3, type: 'subtitle' },
  ],
} as unknown as ProbeSummary;

describe('ffmpegNotes', () => {
  it('turns the known warnings into plain cards', () => {
    const log = [...PGS, NVENC, NUMA, NUMA, 'frame=100 fps=118', NUMA].join('\n');
    expect(ffmpegNotes(log, probe)).toEqual([
      {
        key: 'pgs-3',
        tag: 'warning',
        title: 'Subtitle #2 (PGS image subtitle)',
        text: "ffmpeg couldn't read its size in the quick scan. Copying it works anyway; it only matters if a job fails on this file.",
      },
      {
        key: 'pix-hevc_nvenc',
        tag: 'expected',
        title: 'Encode video pixel format',
        text: 'The 10-bit source is passed to NVENC as p010le. This is normal for NVIDIA hardware encoding and keeps 10-bit.',
      },
      {
        key: 'numa',
        tag: 'expected',
        title: 'x265 memory placement',
        text: "libx265 asks to place its memory per processor and isn't allowed to here (containers often forbid it), so ffmpeg printed this 3 times. It's harmless: the encode isn't affected.",
      },
    ]);
  });

  it('another pixel format change is a warning; a probe-size hint alone is one card', () => {
    const log = [
      "[libx264 @ 0x1] Incompatible pixel format 'yuv444p' for codec 'libx264', auto-selecting format 'yuv420p'",
      PGS[1],
    ].join('\n');
    expect(ffmpegNotes(log, null).map((n) => [n.tag, n.title])).toEqual([
      ['warning', 'Encode video pixel format'],
      ['warning', 'File scan'],
    ]);
  });

  it('nothing known: no cards (unknown warnings stay in the raw output)', () => {
    expect(ffmpegNotes('[mp4 @ 0x1] [warning] something odd\nframe=1', null)).toEqual([]);
    expect(ffmpegNotes('', null)).toEqual([]);
  });

  it('without a probe the subtitle is named by its stream', () => {
    expect(ffmpegNotes(PGS.join('\n'), null)[0]?.title).toBe(
      'Subtitle stream 3 (PGS image subtitle)',
    );
  });
});

describe('shownLog', () => {
  it('collapses the set_mempolicy flood to one line and repeats of any line', () => {
    const log = ['start', NUMA, 'frame=1', NUMA, NUMA, 'dup', 'dup', 'dup', 'end', ''].join('\n');
    expect(shownLog(log)).toBe(
      [
        'start',
        `${NUMA} [3 times, see Notes from ffmpeg]`,
        'frame=1',
        'dup [3 times in a row]',
        'end',
      ].join('\n'),
    );
    expect(logLineCount(log)).toBe(9);
  });

  it("reads the server's repeat marks: the flood's count, a repeated line, the line count", () => {
    const log = [
      'start',
      `${NUMA} [transcoda: 4123 times]`,
      'dup [transcoda: 2 times]',
      'end',
      '',
    ].join('\n');
    expect(shownLog(log)).toBe(
      [
        'start',
        `${NUMA} [4,123 times, see Notes from ffmpeg]`,
        'dup [2 times in a row]',
        'end',
      ].join('\n'),
    );
    expect(logLineCount(log)).toBe(4127);
    expect(ffmpegNotes(log, null)[0]?.text).toContain('printed this 4,123 times');
  });

  it('a flood counted from part of the log says at least', () => {
    const log = ['start', `${NUMA} [transcoda: at least 900 times]`, ''].join('\n');
    expect(shownLog(log)).toBe(
      ['start', `${NUMA} [at least 900 times, see Notes from ffmpeg]`].join('\n'),
    );
    expect(ffmpegNotes(log, null)[0]?.text).toContain('printed this at least 900 times');
  });
});
