import { describe, expect, it } from 'vitest';
import {
  AAC,
  output,
  plan,
  planStream,
  source,
  stream,
  testEncode,
} from '../test/fixtures/beforeAfter.ts';
import { type BeforeAfterJob, compareJob, type Side } from './compareJob.ts';

/** A row as text: label, then each side's items joined as shown, then its loss words. */
const text = (s: Side): string =>
  [s.tag ?? '', s.items.join(', '), s.losses.map((l) => `!${l.word}`).join(' ')]
    .filter(Boolean)
    .join(' ');

function rows(job: BeforeAfterJob): string[][] {
  const c = compareJob(job);
  if (!c) throw new Error('no comparison');
  return c.rows.map((r) => [r.label, text(r.before), text(r.after)]);
}

describe('compareJob', () => {
  it('the test-encode of the example: file, video with ≈ bitrates, two downmixed audio tracks, kept subtitles', () => {
    expect(compareJob(testEncode())?.after).toBe('measured');
    expect(rows(testEncode())).toEqual([
      ['File', '11.6 GB, 13.7 Mb/s, MKV', '2.12 GB, 2.5 Mb/s, MKV'],
      [
        'Video',
        'HEVC Main, 1920×1080, 23.976 fps, 8-bit SDR, ≈9.6 Mb/s',
        'HEVC (NVENC QP 24), 1920×1080, 8-bit, ≈2.2 Mb/s',
      ],
      ['Audio 1', 'TrueHD 5.1, lossless, English', 'AAC 2.0, 160 kb/s !downmixed !lossy'],
      ['Audio 2', 'AC-3 5.1, 640 kb/s, English', 'AAC 2.0, 160 kb/s !downmixed'],
      ['Subtitles', 'PGS, English', 'kept'],
    ]);
  });

  it('an image stored as a video track is a picture: not compared as video, even ahead of it in the output', () => {
    const image = { type: 'video' as const, codec: 'hevc', imageTrack: true, width: 640 };
    const probe = source();
    probe.streams.push(stream({ index: 4, ...image }));
    const outputProbe = output();
    outputProbe.streams.unshift(stream({ index: 0, ...image }));
    outputProbe.streams.forEach((s, i) => {
      s.index = i;
    });
    const p = plan();
    p.streams.push(planStream({ index: 4, type: 'video', codec: 'hevc', language: null }));
    p.output = [{ type: 'video', codec: 'hevc', sourceIndex: 4 }, ...(p.output ?? [])];
    expect(rows(testEncode({ probe, outputProbe, plan: p }))).toEqual(rows(testEncode()));
  });

  it('every loss explains itself in words (the screen reader text)', () => {
    const c = compareJob(testEncode());
    const audio = c?.rows.find((r) => r.label === 'Audio 1');
    expect(audio?.after.losses).toEqual([
      { word: 'downmixed', why: 'fewer channels than the original (5.1 → 2.0)' },
      { word: 'lossy', why: 'the original is lossless, this is not' },
    ]);
  });

  it('ignores a statistics tag the file cannot hold; trusts one that fits; never trusts one on the output', () => {
    // Without the TrueHD tag the video bitrate cannot be derived.
    const noTag = source();
    const truehd = noTag.streams[1];
    if (truehd) truehd.tagBitrateKbps = null;
    expect(rows(testEncode({ probe: noTag }))[1]?.[1]).toBe(
      'HEVC Main, 1920×1080, 23.976 fps, 8-bit SDR, —',
    );
    // A video tag that fits the file is the bitrate, without ≈.
    const fits = source();
    const video = fits.streams[0];
    if (video) video.tagBitrateKbps = 9_500;
    expect(rows(testEncode({ probe: fits }))[1]?.[1]).toBe(
      'HEVC Main, 1920×1080, 23.976 fps, 8-bit SDR, 9.5 Mb/s',
    );
    // ffprobe's own stream bitrate always counts.
    const measured = output();
    const aac = measured.streams[1];
    if (aac) aac.bitrateKbps = 155;
    expect(rows(testEncode({ outputProbe: measured }))[2]?.[2]).toBe(
      'AAC 2.0, 155 kb/s !downmixed !lossy',
    );
  });

  it('marks lower resolution, lower bit depth and lost HDR', () => {
    const hdr = source();
    Object.assign(hdr.streams[0] ?? {}, { bitDepth: 10, hdr: 'hdr10', width: 3840, height: 2160 });
    const c = compareJob(testEncode({ probe: hdr }));
    const video = c?.rows.find((r) => r.label === 'Video');
    expect(video?.before.items).toContain('10-bit HDR10');
    expect(video?.after.items).toContain('8-bit SDR');
    expect(video?.after.losses.map((l) => l.word)).toEqual([
      'downscaled',
      'lower bit depth',
      'HDR lost',
    ]);
  });

  it('a plan-only dry run: After from the plan and the estimate, marked planned; unknowns are —', () => {
    const job = testEncode({
      testEncode: false,
      outputProbe: null,
      result: { beforeBytes: 11_580_000_000, afterBytes: null, estimatedBytes: 2_120_000_000 },
    });
    expect(compareJob(job)?.after).toBe('planned');
    expect(rows(job)).toEqual([
      ['File', '11.6 GB, 13.7 Mb/s, MKV', '2.12 GB (est.), ≈2.5 Mb/s, MKV'],
      [
        'Video',
        'HEVC Main, 1920×1080, 23.976 fps, 8-bit SDR, ≈9.6 Mb/s',
        'HEVC (NVENC QP 24), 1920×1080, 8-bit, —',
      ],
      ['Audio 1', 'TrueHD 5.1, lossless, English', 'AAC 2.0, 160 kb/s !downmixed !lossy'],
      ['Audio 2', 'AC-3 5.1, 640 kb/s, English', 'AAC 2.0, 160 kb/s !downmixed'],
      ['Subtitles', 'PGS, English', 'kept'],
    ]);
    // A size gate decides after encoding: no estimate claims a size.
    const depends = rows({ ...job, dependsOnSize: { minSavingPercent: 25 } });
    expect(depends[0]?.[2]).toBe('—, MKV');
  });

  it('a removed track says removed (a loss); an added one says added before', () => {
    const probe = source();
    probe.streams.push(
      stream({ index: 4, type: 'audio', codec: 'dts', channels: 6, language: 'deu' }),
    );
    const p = plan();
    p.streams.splice(
      2,
      0,
      planStream({
        index: 1,
        type: 'audio',
        codec: 'aac',
        action: 'convert',
        note: `added: ${AAC}`,
      }),
    );
    p.streams[1] = planStream({ index: 1, type: 'audio', codec: 'truehd' });
    p.streams.push(
      planStream({ index: 4, type: 'audio', codec: 'dts', language: 'deu', action: 'drop' }),
    );
    p.output = [
      { type: 'video', codec: 'hevc', sourceIndex: 0, bitDepth: 8 },
      { type: 'audio', codec: 'truehd', sourceIndex: 1, channels: 6 },
      { type: 'audio', codec: 'aac', sourceIndex: 1, channels: 2 },
      { type: 'audio', codec: 'aac', sourceIndex: 2, channels: 2 },
      { type: 'subtitle', codec: 'hdmv_pgs_subtitle', sourceIndex: 3 },
    ];
    const job = testEncode({ probe, plan: p, outputProbe: null, testEncode: false });
    expect(rows(job).slice(2)).toEqual([
      ['Audio 1', 'TrueHD 5.1, lossless, English', 'kept'],
      ['Audio 2', 'added', 'AAC 2.0, 160 kb/s, English'],
      ['Audio 3', 'AC-3 5.1, 640 kb/s, English', 'AAC 2.0, 160 kb/s !downmixed'],
      ['Audio 4', 'DTS 5.1, —, German', '!removed'],
      ['Subtitles', 'PGS, English', 'kept'],
    ]);
  });

  it('pairs output tracks by their source, also when the output reorders them', () => {
    const p = plan();
    p.output = [
      { type: 'video', codec: 'hevc', sourceIndex: 0, bitDepth: 8 },
      { type: 'audio', codec: 'aac', sourceIndex: 2, channels: 2 },
      { type: 'audio', codec: 'aac', sourceIndex: 1, channels: 1 },
      { type: 'subtitle', codec: 'hdmv_pgs_subtitle', sourceIndex: 3 },
    ];
    const out = output();
    Object.assign(out.streams[2] ?? {}, { channels: 1 });
    expect(rows(testEncode({ plan: p, outputProbe: out }))[2]?.[2]).toBe(
      'AAC mono, 160 kb/s !downmixed !lossy',
    );
  });

  it('an added copy before its original in the output: pairs by source and codec, and the kept track lends its rate to the ≈ video bitrate', () => {
    const p = plan();
    p.streams.splice(
      1,
      1,
      planStream({ index: 1, type: 'audio', codec: 'truehd' }),
      planStream({
        index: 1,
        type: 'audio',
        codec: 'aac',
        action: 'convert',
        note: `added: ${AAC}`,
      }),
    );
    // The added AAC is written first (it became the default).
    p.output = [
      { type: 'video', codec: 'hevc', sourceIndex: 0, bitDepth: 8 },
      { type: 'audio', codec: 'aac', sourceIndex: 1, channels: 2 },
      { type: 'audio', codec: 'truehd', sourceIndex: 1, channels: 6 },
      { type: 'audio', codec: 'aac', sourceIndex: 2, channels: 2 },
      { type: 'subtitle', codec: 'hdmv_pgs_subtitle', sourceIndex: 3 },
    ];
    const out = output();
    out.bitrateKbps = 6_000;
    out.streams.splice(
      1,
      2,
      stream({ index: 1, type: 'audio', codec: 'aac', channels: 2, language: 'eng' }),
      stream({ index: 2, type: 'audio', codec: 'truehd', channels: 6, language: 'eng' }),
      stream({ index: 3, type: 'audio', codec: 'aac', channels: 2, language: 'eng' }),
    );
    expect(rows(testEncode({ plan: p, outputProbe: out })).slice(1, 4)).toEqual([
      // 6000 − (3460 TrueHD, its source's trusted rate, + 160 + 160)
      [
        'Video',
        'HEVC Main, 1920×1080, 23.976 fps, 8-bit SDR, ≈9.6 Mb/s',
        'HEVC (NVENC QP 24), 1920×1080, 8-bit, ≈2.2 Mb/s',
      ],
      ['Audio 1', 'TrueHD 5.1, lossless, English', 'kept'],
      ['Audio 2', 'added', 'AAC 2.0, 160 kb/s, English'],
    ]);
  });

  it('marks Dolby Vision that becomes HDR10', () => {
    const dv = source();
    Object.assign(dv.streams[0] ?? {}, { bitDepth: 10, hdr: 'dolby-vision' });
    const out = output();
    Object.assign(out.streams[0] ?? {}, { bitDepth: 10, hdr: 'hdr10' });
    const video = compareJob(testEncode({ probe: dv, outputProbe: out }))?.rows[1];
    expect(video?.after.items).toContain('10-bit HDR10');
    expect(video?.after.losses).toEqual([
      { word: 'Dolby Vision lost', why: 'the original is Dolby Vision, this is HDR10' },
    ]);
  });

  it('says where After comes from', () => {
    const real = { dryRun: false, testEncode: false };
    const noProbe = { outputProbe: null };
    const mode = (over: Partial<BeforeAfterJob>) => compareJob(testEncode(over))?.after;
    expect(mode({})).toBe('measured');
    expect(mode({ ...real, state: 'done' })).toBe('measured');
    // A test-encode keeps its output (the test output); a real run's kept original threw it away.
    expect(mode({ state: 'kept_original' })).toBe('measured');
    expect(mode({ ...real, state: 'kept_original' })).toBe('not-kept');
    // No stored output probe (jobs from before it was kept): the plan, with the measured size.
    expect(mode({ ...real, ...noProbe, state: 'done' })).toBe('from-plan');
    expect(mode({ ...noProbe })).toBe('from-plan');
    expect(rows(testEncode({ ...real, ...noProbe, state: 'done' }))[0]?.[2]).toBe(
      '2.12 GB, 2.5 Mb/s, MKV',
    );
    // Only a plan-only dry run is planned.
    expect(mode({ ...noProbe, testEncode: false })).toBe('planned');
  });

  it('a failed or cancelled job has nothing to compare, even with an output probe', () => {
    for (const state of ['failed', 'cancelled'] as const) {
      expect(compareJob(testEncode({ state, dryRun: false, testEncode: false }))).toBeNull();
    }
  });

  it('nothing to compare without a probe, for a failed job, and for a plan that changes nothing', () => {
    expect(compareJob(testEncode({ probe: null }))).toBeNull();
    expect(compareJob(testEncode({ state: 'failed', outputProbe: null }))).toBeNull();
    expect(
      compareJob(
        testEncode({ outputProbe: null, testEncode: false, plan: { ...plan(), rewrite: false } }),
      ),
    ).toBeNull();
  });
});
