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
    media: episode('Andor', 2, 7),
    fileName: 'Andor S02E07.mkv',
    filePath: '/media/shows/Andor/Andor S02E07.mkv',
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
    id: 'j-bluey4',
    state: 'encoding',
    lane: 'encode',
    media: episode('Bluey', 1, 4),
    fileName: 'Bluey S01E04.mp4',
    filePath: '/media/shows/Bluey/Bluey S01E04.mp4',
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
    id: 'j-severance',
    state: 'verifying',
    lane: 'quick',
    media: episode('Severance', 2, 1),
    fileName: 'Severance S02E01.mkv',
    startedAt: '2026-10-16T18:01:00.000Z',
  }),
  queued: job({ id: 'j-andor', state: 'queued' }),
  replaced: job({
    id: 'j-bluey3',
    state: 'done',
    media: episode('Bluey', 1, 3),
    fileName: 'Bluey S01E03.mp4',
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
    id: 'j-dune',
    state: 'kept_original',
    media: {
      kind: 'movie',
      title: 'Dune Part Two',
      year: 2024,
      season: null,
      episode: null,
      episodeTitle: null,
      source: 'filename',
      poster: false,
    },
    fileName: 'Dune Part Two (2024).mkv',
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
    media: episode('The Bear', 3, 2),
    fileName: 'The Bear S03E02.mkv',
    ...finished,
  }),
  skipped: job({
    id: 'j-shogun',
    state: 'skipped',
    media: episode('Shogun', 1, 9),
    fileName: 'Shogun S01E09.mkv',
    ...finished,
    reason: 'Hardlinked by the torrent client',
  }),
  failed: job({
    id: 'j-arcane',
    state: 'failed',
    media: episode('Arcane', 2, 5),
    fileName: 'Arcane S02E05.mkv',
    ...finished,
    reason: 'Verification failed: output 4 s shorter',
  }),
  dry: job({
    id: 'j-fallout',
    state: 'dry_run',
    dryRun: true,
    media: episode('Fallout', 1, 1),
    fileName: 'Fallout S01E01.mkv',
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
