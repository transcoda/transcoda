import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jobs: { deleteTestOutput: vi.fn() },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { ORPCError } from '@orpc/client';
import type { JobDetail } from '@transcoda/contract';
import { ToastProvider } from '../components/Toast.tsx';
import { TestOutputPanel } from './TestOutputPanel.tsx';

type PanelJob = Pick<JobDetail, 'id' | 'testEncode' | 'testOutput' | 'testOutputNote'> &
  Partial<Pick<JobDetail, 'plan'>>;

// Wednesday 21 Oct 2026, 12:00 local time.
const NOW = new Date(2026, 9, 21, 12, 0, 0);
const at = (d: Date) => d.toISOString();

function kept(until: Date, over: Partial<PanelJob> = {}): PanelJob {
  return {
    id: 'j1',
    testEncode: true,
    testOutput: { keptUntil: at(until), sizeBytes: 190_000_000, container: 'mkv' },
    testOutputNote: null,
    ...over,
  };
}

function show(job: PanelJob, onChanged = vi.fn()) {
  render(
    <ToastProvider>
      <TestOutputPanel job={job} onChanged={onChanged} />
    </ToastProvider>,
  );
  return onChanged;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  mocks.jobs.deleteTestOutput.mockReset().mockResolvedValue({ ok: true });
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TestOutputPanel', () => {
  it('says until when today it is kept, with its size, Play, Download and Delete now', () => {
    show(kept(new Date(2026, 9, 21, 14, 5)));
    expect(screen.getByRole('heading', { name: 'Test output kept until 14:05' })).toBeTruthy();
    expect(screen.getByText('190 MB')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    const download = screen.getByRole('link', { name: 'Download' });
    expect(download.getAttribute('href')).toBe('/api/v1/jobs/j1/test-output');
    expect(download.hasAttribute('download')).toBe(true);
    expect(screen.getByRole('button', { name: 'Delete now' })).toBeTruthy();
  });

  it('names the weekday when it is kept past today', () => {
    show(kept(new Date(2026, 9, 22, 9, 15)));
    expect(screen.getByRole('heading', { name: 'Test output kept until Thu 09:15' })).toBeTruthy();
  });

  it('Play shows an inline player on the play URL and becomes Hide player', () => {
    show(kept(new Date(2026, 9, 21, 14, 5)));
    expect(document.querySelector('video')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('/api/v1/jobs/j1/test-output?play=1');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.getAttribute('preload')).toBe('metadata');
    fireEvent.click(screen.getByRole('button', { name: 'Hide player' }));
    expect(document.querySelector('video')).toBeNull();
  });

  it('says it is preparing the preview until the video has its metadata', () => {
    show(kept(new Date(2026, 9, 21, 14, 5)));
    expect(screen.queryByText('Preparing preview…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByText('Preparing preview…')).toBeTruthy();
    fireEvent.loadedMetadata(document.querySelector('video') as HTMLVideoElement);
    expect(screen.queryByText('Preparing preview…')).toBeNull();
    expect(document.querySelector('video')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Hide player' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete now' })).toBeTruthy();

    // Opened again, it waits for the metadata again.
    fireEvent.click(screen.getByRole('button', { name: 'Hide player' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByText('Preparing preview…')).toBeTruthy();
  });

  describe('codecs', () => {
    type Output = NonNullable<NonNullable<JobDetail['plan']>['output']>;
    const withPlan = (output?: Output, container: 'mkv' | 'mp4' = 'mkv') =>
      kept(new Date(2026, 9, 21, 14, 5), {
        testOutput: { keptUntil: at(new Date(2026, 9, 21, 14, 5)), sizeBytes: 1, container },
        plan: {
          container: { from: 'mkv', to: container },
          streams: [],
          rewrite: true,
          ...(output ? { output } : {}),
        },
      });
    const hevc10Eac3: Output = [
      { type: 'video', codec: 'hevc', bitDepth: 10 },
      { type: 'audio', codec: 'eac3', channels: 6 },
      { type: 'audio', codec: 'aac', channels: 2 },
    ];
    const canPlay = (yes: string[]) =>
      vi
        .spyOn(HTMLMediaElement.prototype, 'canPlayType')
        .mockImplementation((type) => (yes.some((c) => type.includes(`"${c}"`)) ? 'maybe' : ''));
    const play = () => fireEvent.click(screen.getByRole('button', { name: 'Play' }));

    afterEach(() => vi.restoreAllMocks());

    it('names the video and the audio this browser cannot play, by mp4 codec string', () => {
      const spy = canPlay([]);
      show(withPlan(hevc10Eac3));
      expect(screen.queryByText(/This browser can't play/)).toBeNull();
      play();
      expect(screen.getByText("This browser can't play HEVC 10-bit video.")).toBeTruthy();
      expect(
        screen.getByText(
          "This browser can't play E-AC-3 5.1 audio, so the preview plays without sound. Download the file to check the audio.",
        ),
      ).toBeTruthy();
      expect(spy).toHaveBeenCalledWith('video/mp4; codecs="hvc1.2.4.L153.B0"');
      expect(spy).toHaveBeenCalledWith('video/mp4; codecs="ec-3"');
    });

    it('says nothing about codecs the browser plays', () => {
      const spy = canPlay(['hvc1.1.6.L93.B0', 'mp4a.40.2']);
      show(
        withPlan([
          { type: 'video', codec: 'hevc', bitDepth: 8 },
          { type: 'audio', codec: 'aac', channels: 2 },
        ]),
      );
      play();
      expect(spy).toHaveBeenCalledWith('video/mp4; codecs="hvc1.1.6.L93.B0"');
      expect(screen.queryByText(/can't/)).toBeNull();
      expect(screen.queryByText(/without sound/)).toBeNull();
    });

    it('says when the mkv preview cannot carry the audio', () => {
      canPlay(['avc1.640028']);
      show(
        withPlan([
          { type: 'video', codec: 'h264', bitDepth: 8 },
          { type: 'audio', codec: 'dts', channels: 8 },
        ]),
      );
      play();
      expect(
        screen.getByText("The preview can't carry DTS 7.1 audio, so it plays without sound."),
      ).toBeTruthy();
      expect(screen.queryByText(/This browser can't play/)).toBeNull();
    });

    it('an mp4 output plays as it is: only what the browser cannot play is named', () => {
      canPlay(['avc1.640028']);
      show(
        withPlan(
          [
            { type: 'video', codec: 'h264' },
            { type: 'audio', codec: 'dts' },
          ],
          'mp4',
        ),
      );
      play();
      expect(screen.queryByText(/can't carry/)).toBeNull();
      expect(
        screen.getByText(
          "This browser can't play DTS audio, so the preview plays without sound. Download the file to check the audio.",
        ),
      ).toBeTruthy();
    });

    it('an mkv whose plan does not list its tracks plays without sound', () => {
      canPlay([]);
      show(withPlan(undefined));
      play();
      expect(screen.getByText('The preview plays without sound.')).toBeTruthy();
    });

    it('a player error names the video codec the browser cannot play', async () => {
      canPlay([]);
      show(withPlan(hevc10Eac3));
      play();
      await act(async () => {
        fireEvent.error(document.querySelector('video') as HTMLVideoElement);
      });
      expect(
        screen.getByText(
          "Could not play the preview: this browser can't play HEVC 10-bit video. Use Download to get the file instead.",
        ),
      ).toBeTruthy();
    });
  });

  it('Delete now deletes and tells the page', async () => {
    const onChanged = show(kept(new Date(2026, 9, 21, 14, 5)));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete now' }));
    });
    expect(mocks.jobs.deleteTestOutput).toHaveBeenCalledWith({ id: 'j1' });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('Delete now of an output already gone tells the page too', async () => {
    mocks.jobs.deleteTestOutput.mockRejectedValue(
      new ORPCError('NOT_FOUND', { defined: true, message: 'gone' }),
    );
    const onChanged = show(kept(new Date(2026, 9, 21, 14, 5)));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete now' }));
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('a failed Delete now toasts and keeps the output', async () => {
    mocks.jobs.deleteTestOutput.mockRejectedValue(new Error('boom'));
    const onChanged = show(kept(new Date(2026, 9, 21, 14, 5)));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete now' }));
    });
    expect(screen.getByText("Couldn't delete the test output")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete now' })).toBeTruthy();
  });

  it('expires on time without a reload', () => {
    show(kept(new Date(2026, 9, 21, 14, 5)));
    act(() => {
      vi.advanceTimersByTime(2 * 3_600_000 + 5 * 60_000 + 1);
    });
    expect(screen.getByText('Test output expired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Download' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete now' })).toBeNull();
  });

  it('a kept-until already past reads as expired', () => {
    show(kept(new Date(2026, 9, 21, 11, 0)));
    expect(screen.getByText('Test output expired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
  });

  it('a player error on an output that is gone says so and tells the page', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    const onChanged = show(kept(new Date(2026, 9, 21, 14, 5)));
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await act(async () => {
      fireEvent.error(document.querySelector('video') as HTMLVideoElement);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/jobs/j1/test-output?play=1',
      expect.objectContaining({ method: 'HEAD' }),
    );
    expect(screen.getByText('This test output is gone.')).toBeTruthy();
    expect(document.querySelector('video')).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('a player error on an output still there offers Download instead', async () => {
    const onChanged = show(kept(new Date(2026, 9, 21, 14, 5)));
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await act(async () => {
      fireEvent.error(document.querySelector('video') as HTMLVideoElement);
    });
    expect(
      screen.getByText('Could not play the preview. Use Download to get the file instead.'),
    ).toBeTruthy();
    expect(screen.queryByText('Preparing preview…')).toBeNull();
    expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();
    expect(document.querySelector('video')).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it.each([
    ['busy', 'The server is busy preparing other previews. Try again in a few seconds.'],
    ['building', 'The server is busy preparing other previews. Try again in a few seconds.'],
    ['scratchLow', 'Not enough scratch space to prepare the preview.'],
    ['none', 'Could not prepare the preview. Use Download to get the file instead.'],
  ])('a player error with x-preview %s says so and offers Try again', async (state, line) => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 200, headers: { 'x-preview': state } }),
    );
    const onChanged = show(kept(new Date(2026, 9, 21, 14, 5)));
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await act(async () => {
      fireEvent.error(document.querySelector('video') as HTMLVideoElement);
    });
    expect(screen.getByText(line)).toBeTruthy();
    expect(document.querySelector('video')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.queryByText(line)).toBeNull();
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('/api/v1/jobs/j1/test-output?play=1');
    expect(screen.getByText('Preparing preview…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide player' })).toBeTruthy();
  });

  it('a player error on a built preview is the browser: no Try again', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 200, headers: { 'x-preview': 'ready' } }),
    );
    show(kept(new Date(2026, 9, 21, 14, 5)));
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await act(async () => {
      fireEvent.error(document.querySelector('video') as HTMLVideoElement);
    });
    expect(
      screen.getByText('Could not play the preview. Use Download to get the file instead.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it.each([
    ['not kept: scratch space low', 'Test output not kept: scratch space low'],
    [
      'not kept: test encodes are kept for 0 hours',
      'Test output not kept: test encodes are kept for 0 hours',
    ],
    ['deleted', 'Test output deleted'],
    ['expired', 'Test output expired'],
    ['deleted: scratch space was needed', 'Test output deleted: scratch space was needed'],
    ['deleted: file missing', 'Test output deleted: file missing'],
    ['not kept: EXDEV', 'Test output not kept: EXDEV'],
  ])('note %s reads %s', (note, line) => {
    show({ id: 'j1', testEncode: true, testOutput: null, testOutputNote: note });
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('Delete now says the job result stays', () => {
    show(kept(new Date(2026, 9, 21, 14, 5)));
    const button = screen.getByRole('button', { name: 'Delete now' });
    const hintId = button.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId as string)?.textContent).toBe(
      'Removes the kept output; the job result stays',
    );
  });

  it('without an output or a note it shows nothing', () => {
    show({ id: 'j1', testEncode: true, testOutput: null, testOutputNote: null });
    expect(document.querySelector('.test-output')).toBeNull();
  });

  it('a plan-only dry run shows nothing', () => {
    show(kept(new Date(2026, 9, 21, 14, 5), { testEncode: false }));
    expect(document.querySelector('.test-output')).toBeNull();
  });
});
