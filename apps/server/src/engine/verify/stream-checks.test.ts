import { describe, expect, it } from 'vitest';
import { modelFromProbe } from '../model/model.ts';
import { probeOf } from '../testing/builders.ts';
import { streamFailures } from './stream-checks.ts';

describe('streamFailures: the chapter track an mp4 muxer adds', () => {
  const mp4 = (streams: Parameters<typeof probeOf>[0]) =>
    probeOf(streams, { container: 'mp4', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', chapters: 2 });

  it('an extra bin_data track in an mp4 output is the chapter track, not a stream gone wrong', () => {
    const source = mp4([
      { type: 'video', codec: 'h264' },
      { type: 'audio', codec: 'aac' },
    ]);
    const out = mp4([
      { type: 'video', codec: 'h264' },
      { type: 'audio', codec: 'aac' },
      { type: 'data', codec: 'bin_data' },
    ]);
    expect(streamFailures(modelFromProbe(source), out)).toEqual([]);
  });

  it("with the source's own chapter track and a cover, the streams still line up", () => {
    const source = mp4([
      { type: 'video', codec: 'hevc' },
      { type: 'audio', codec: 'eac3' },
      { type: 'data', codec: 'bin_data' },
      { type: 'video', codec: 'mjpeg', attachedPic: true },
    ]);
    const out = mp4([
      { type: 'video', codec: 'hevc' },
      { type: 'audio', codec: 'eac3' },
      { type: 'data', codec: 'bin_data' },
      { type: 'data', codec: 'bin_data' },
      { type: 'video', codec: 'mjpeg', attachedPic: true },
    ]);
    expect(streamFailures(modelFromProbe(source), out)).toEqual([]);
  });

  it('a missing audio track in an mp4 still fails, and an mkv keeps counting data streams', () => {
    const source = mp4([
      { type: 'video', codec: 'h264' },
      { type: 'audio', codec: 'aac' },
    ]);
    const out = mp4([
      { type: 'video', codec: 'h264' },
      { type: 'data', codec: 'bin_data' },
    ]);
    expect(streamFailures(modelFromProbe(source), out).map((f) => f.check)).toContain(
      'stream-count',
    );
    const mkv = probeOf([{ type: 'video' }, { type: 'audio' }]);
    const mkvOut = probeOf([
      { type: 'video' },
      { type: 'audio' },
      { type: 'data', codec: 'bin_data' },
    ]);
    expect(streamFailures(modelFromProbe(mkv), mkvOut).map((f) => f.check)).toContain(
      'stream-count',
    );
  });
});
