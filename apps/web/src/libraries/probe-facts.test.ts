import type { JobProbe } from '@transcoda/contract';
import { describe, expect, it } from 'vitest';
import { probeFacts } from './probe-facts.ts';

type Stream = JobProbe['streams'][number];

const stream = (over: Partial<Stream>): Stream => ({
  index: 0,
  type: 'video',
  codec: 'hevc',
  language: null,
  title: null,
  default: false,
  forced: false,
  attachedPic: false,
  dispositions: [],
  width: null,
  height: null,
  profile: null,
  level: null,
  pixelFormat: null,
  bitDepth: null,
  hdr: null,
  channels: null,
  sampleRate: null,
  bitrateKbps: null,
  frameRate: null,
  tagBitrateKbps: null,
  ...over,
});

const probe = (streams: Stream[], over: Partial<JobProbe> = {}): JobProbe => ({
  container: 'mkv',
  durationSeconds: 5520,
  sizeBytes: 1_000_000_000,
  bitrateKbps: null,
  streams,
  ...over,
});

describe('probeFacts', () => {
  it('names the container, length, video, audio and subtitle tracks', () => {
    const facts = probeFacts(
      probe([
        stream({ index: 0, type: 'video', codec: 'hevc', width: 1920, height: 1080 }),
        stream({
          index: 1,
          type: 'audio',
          codec: 'aac',
          language: 'eng',
          channels: 6,
          default: true,
        }),
        stream({ index: 2, type: 'subtitle', codec: 'subrip', language: 'eng', forced: true }),
        stream({ index: 3, type: 'subtitle', codec: 'subrip', language: 'ger' }),
      ]),
    );
    expect(facts).toEqual({
      container: 'mkv',
      length: '1 h 32 min',
      video: 'HEVC 1920×1080',
      audio: ['English · AAC 5.1 (default)'],
      subtitles: ['English (forced)', 'German'],
    });
  });

  it('has no video when the file has no video stream', () => {
    const facts = probeFacts(
      probe([stream({ index: 0, type: 'audio', codec: 'aac', language: 'eng', channels: 2 })]),
    );
    expect(facts.video).toBeNull();
    expect(facts.audio).toEqual(['English · AAC stereo']);
    expect(facts.subtitles).toEqual([]);
  });

  it('skips a cover picture when it picks the video stream', () => {
    const facts = probeFacts(
      probe([
        stream({
          index: 0,
          type: 'video',
          codec: 'mjpeg',
          attachedPic: true,
          width: 600,
          height: 900,
        }),
        stream({ index: 1, type: 'video', codec: 'h264', width: 1280, height: 720 }),
      ]),
    );
    expect(facts.video).toBe('H.264 1280×720');
  });

  it('says Untagged for a track without a language', () => {
    const facts = probeFacts(
      probe([stream({ index: 0, type: 'subtitle', codec: 'subrip', language: null })]),
    );
    expect(facts.subtitles).toEqual(['Untagged']);
  });
});
