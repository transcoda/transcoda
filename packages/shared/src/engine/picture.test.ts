import { describe, expect, it } from 'vitest';
import { isPicture } from './probe.ts';

const v = (
  codec: string,
  extra: { attachedPic?: boolean; dispositions?: string[]; imageTrack?: boolean } = {},
) => ({
  type: 'video' as const,
  codec,
  attachedPic: extra.attachedPic ?? false,
  dispositions: extra.dispositions ?? [],
  ...(extra.imageTrack ? { imageTrack: true } : {}),
});

describe('isPicture', () => {
  it('JPEG tracks next to a real video are pictures (the Paddington 2 remux: hevc + 4 mjpeg)', () => {
    const streams = [v('hevc'), v('mjpeg'), v('mjpeg'), v('mjpeg'), v('mjpeg')];
    expect(streams.map((s) => isPicture(s, streams))).toEqual([false, true, true, true, true]);
  });

  it('flagged covers and still images are pictures whatever their codec', () => {
    const streams = [
      v('h264'),
      v('png', { attachedPic: true }),
      v('h264', { dispositions: ['still_image'] }),
    ];
    expect(streams.map((s) => isPicture(s, streams))).toEqual([false, true, true]);
  });

  it('a file whose only video is MJPEG (a camera clip) keeps it as video; audio is never a picture', () => {
    const clip = [v('mjpeg')];
    expect(isPicture(clip[0] as ReturnType<typeof v>, clip)).toBe(false);
    expect(
      isPicture({ type: 'audio', codec: 'mjpeg', attachedPic: false, dispositions: [] }, [
        v('hevc'),
      ]),
    ).toBe(false);
  });

  it('a track the probe marked imageTrack is a picture whatever its codec, and not real video', () => {
    // hevc main + an image re-encoded to a one-frame hevc track + a JPEG poster.
    const streams = [v('hevc'), v('hevc', { imageTrack: true }), v('mjpeg')];
    expect(streams.map((s) => isPicture(s, streams))).toEqual([false, true, true]);
    // An image track is no real video: a JPEG next to it alone stays video.
    const only = [v('hevc', { imageTrack: true }), v('mjpeg')];
    expect(only.map((s) => isPicture(s, only))).toEqual([true, false]);
  });
});
