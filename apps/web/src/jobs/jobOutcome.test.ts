import { describe, expect, it } from 'vitest';
import { failureCause, jobWhenLine } from './jobOutcome.ts';

describe('failureCause', () => {
  it('a probe failure is "The file could not be read", with ffprobe\'s message in words', () => {
    expect(failureCause('probe failed: Invalid data found when processing input')).toEqual({
      headline: 'The file could not be read',
      text: 'ffprobe found invalid data in the file, so the workflow never started.',
    });
  });

  it('an older probe reason drops the command line and the path, and keeps the demuxer message', () => {
    const reason = [
      'probe failed: Command failed: ffprobe -v error -show_format -of json /media/movies/broken.mkv',
      '[matroska,webm @ 0x90903c000] EBML header parsing failed',
      '/media/movies/broken.mkv: Invalid data found when processing input',
    ].join('\n');
    expect(failureCause(reason)).toEqual({
      headline: 'The file could not be read',
      text: 'ffprobe found invalid data in the file (EBML header parsing failed), so the workflow never started.',
    });
  });

  it('other probe messages are said as they are, as a sentence', () => {
    expect(failureCause('probe failed: ffprobe took too long and was stopped').text).toBe(
      'ffprobe took too long and was stopped, so the workflow never started.',
    );
    expect(failureCause('probe failed: No such file or directory').text).toBe(
      'The file is no longer there, so the workflow never started.',
    );
  });

  it('known engine prefixes get a cause; the rest of the reason is the sentence', () => {
    expect(failureCause('verify: duration: 10 s shorter than the source')).toEqual({
      headline: 'The encoded file did not pass the checks',
      text: 'Duration: 10 s shorter than the source.',
    });
    expect(failureCause('encode could not read the source: bad packet')).toEqual({
      headline: 'The encode failed',
      text: 'Encode could not read the source: bad packet.',
    });
    expect(failureCause('ffmpeg could not start: spawn ENOENT')).toEqual({
      headline: 'The encode failed',
      text: 'ffmpeg could not start: spawn ENOENT.',
    });
    expect(failureCause('workflow missing')).toEqual({
      headline: 'The workflow no longer exists',
      text: null,
    });
    expect(failureCause('interrupted; original restored')).toEqual({
      headline: 'The job was interrupted',
      text: 'Original restored.',
    });
  });

  it('an unknown reason is "The job failed" with the reason; no reason has no sentence', () => {
    expect(failureCause('something odd happened')).toEqual({
      headline: 'The job failed',
      text: 'Something odd happened.',
    });
    expect(failureCause(null)).toEqual({ headline: 'The job failed', text: null });
  });
});

describe('jobWhenLine', () => {
  const now = new Date('2026-10-23T12:00:00Z');
  const job = {
    state: 'done' as const,
    queuedAt: '2026-10-20T10:28:00Z',
    startedAt: '2026-10-20T10:29:00Z',
    finishedAt: '2026-10-20T10:29:03Z',
  };

  it('a finished job says when it finished and how long it took', () => {
    expect(jobWhenLine(job, true, now)).toMatch(/^Finished Oct 20, \d\d:\d\d · took 3 s$/);
  });

  it('under a day it is relative', () => {
    expect(
      jobWhenLine({ ...job, finishedAt: '2026-10-23T11:52:00Z', startedAt: null }, true, now),
    ).toBe('Finished 8 min ago');
  });

  it('a running job says when it started, a queued one when it was queued', () => {
    expect(
      jobWhenLine(
        { ...job, state: 'encoding', startedAt: '2026-10-23T11:58:00Z', finishedAt: null },
        false,
        now,
      ),
    ).toBe('Started 2 min ago');
    expect(
      jobWhenLine(
        {
          ...job,
          state: 'queued',
          queuedAt: '2026-10-23T11:59:30Z',
          startedAt: null,
          finishedAt: null,
        },
        false,
        now,
      ),
    ).toBe('Queued just now');
  });
});
