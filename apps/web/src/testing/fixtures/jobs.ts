// Job rows for the jobs screens' tests: one per row of screen 07 (file names, places and details as
// drawn), built on one base row so a test overrides only what it is about.
import type { Job } from '@transcoda/contract';
import { JOB_STATES, type JobState } from '@transcoda/shared';

type Media = Job['media'];
const episode = (title: string, season: number, number: number): Media => ({
  kind: 'episode',
  title,
  year: null,
  season,
  episode: number,
  episodeTitle: null,
  source: 'filename',
  poster: false,
});

export function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j-base',
    runId: 'r1',
    state: 'queued',
    paused: false,
    lane: null,
    attempt: 1,
    encodedOn: null,
    failedGpus: [],
    priority: 0,
    heldByRunHours: null,
    dryRun: false,
    testEncode: false,
    media: episode('Starfall', 2, 7),
    fileName: 'Starfall S02E07.mkv',
    filePath: '/media/shows/Starfall/Starfall S02E07.mkv',
    libraryId: 'lib-shows',
    libraryName: 'Shows',
    workflowId: 'wf-tv',
    workflowVersion: 7,
    workflowName: 'TV cleanup',
    progress: null,
    queuedAt: '2026-10-16T18:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    reason: null,
    result: null,
    problems: [],
    estimatedBytes: null,
    planSummary: null,
    dependsOnSize: null,
    ...overrides,
  };
}

const finished = { startedAt: '2026-10-16T18:01:00.000Z', finishedAt: '2026-10-16T18:20:00.000Z' };

export const fx = {
  running: job({
    id: 'j-maple-lane4',
    state: 'encoding',
    lane: 'encode',
    media: episode('Maple Lane', 1, 4),
    fileName: 'Maple Lane S01E04.mp4',
    filePath: '/media/shows/Maple Lane/Maple Lane S01E04.mp4',
    startedAt: '2026-10-16T18:01:00.000Z',
    progress: {
      percent: 42.3,
      outTimeSeconds: 290,
      speed: 4.9,
      fps: 118.4,
      sizeBytes: 300_000_000,
      etaSeconds: 170,
    },
  }),
  verifying: job({
    id: 'j-blue-ledger',
    state: 'verifying',
    lane: 'quick',
    media: episode('Blue Ledger', 2, 1),
    fileName: 'Blue Ledger S02E01.mkv',
    startedAt: '2026-10-16T18:01:00.000Z',
  }),
  queued: job({ id: 'j-starfall', state: 'queued' }),
  replaced: job({
    id: 'j-maple-lane3',
    state: 'done',
    media: episode('Maple Lane', 1, 3),
    fileName: 'Maple Lane S01E03.mp4',
    ...finished,
    result: {
      outcome: 'done',
      beforeBytes: 2_410_000_000,
      afterBytes: 1_620_000_000,
      replacedTo: 'recycle',
      sourceDamaged: false,
    },
  }),
  kept: job({
    id: 'j-nosferatu',
    state: 'kept_original',
    media: {
      kind: 'movie',
      title: 'Nosferatu',
      year: 1922,
      season: null,
      episode: null,
      episodeTitle: null,
      source: 'filename',
      poster: false,
    },
    fileName: 'Nosferatu (1922).mkv',
    libraryId: 'lib-movies',
    libraryName: 'Movies',
    workflowId: 'wf-movie',
    workflowName: 'Movie shrink',
    workflowVersion: 3,
    ...finished,
    reason: 'Only 6% smaller, size gate needs 20%',
  }),
  noop: job({
    id: 'j-bear',
    state: 'nothing_to_do',
    media: episode('Corner Kitchen', 3, 2),
    fileName: 'Corner Kitchen S03E02.mkv',
    ...finished,
  }),
  skipped: job({
    id: 'j-iron-harbor',
    state: 'skipped',
    media: episode('Iron Harbor', 1, 9),
    fileName: 'Iron Harbor S01E09.mkv',
    ...finished,
    reason: 'Hardlinked by the torrent client',
  }),
  failed: job({
    id: 'j-clockwork-hollow',
    state: 'failed',
    media: episode('Clockwork Hollow', 2, 5),
    fileName: 'Clockwork Hollow S02E05.mkv',
    ...finished,
    reason: 'Verification failed: output 4 s shorter',
  }),
  dry: job({
    id: 'j-dust-belt',
    state: 'dry_run',
    dryRun: true,
    media: episode('Dust Belt', 1, 1),
    fileName: 'Dust Belt S01E01.mkv',
    workflowId: 'wf-kids',
    workflowName: 'Kids audio',
    workflowVersion: 1,
    ...finished,
    reason: 'would drop 9 tracks',
  }),
} satisfies Record<string, Job>;

/** `jobs.list` counts with every state present (zero unless given). */
export function counts(partial: Partial<Record<JobState, number>> = {}): Record<JobState, number> {
  const all = Object.fromEntries(JOB_STATES.map((s) => [s, 0])) as Record<JobState, number>;
  return { ...all, ...partial };
}
