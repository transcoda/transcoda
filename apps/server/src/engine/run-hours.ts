// Run hours on the server: which libraries hold back their automatic (`library`) jobs right now.
import { isOpenAt, nextOpening } from '@transcoda/shared';
import type { Database } from '../db/open.ts';
import type { JobListRow } from '../db/repos/jobs.ts';
import { listLibraries } from '../db/repos/libraries.ts';

/** The server's own time zone (the container's `TZ`, else UTC): run hours are read in it. */
export const serverTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The live libraries whose run hours are closed at `now`, each with the time its window opens
 * next (null: no hours chosen, it never opens). A library without run hours is never here.
 */
export function closedLibraries(
  db: Database,
  now: Date,
  timeZone: string,
): Map<string, Date | null> {
  const closed = new Map<string, Date | null>();
  for (const library of listLibraries(db)) {
    const rh = library.runHours;
    if (!rh || isOpenAt(rh, now, timeZone)) continue;
    closed.set(library.id, nextOpening(rh, now, timeZone));
  }
  return closed;
}

export interface RunHoursHold {
  opensAt: string | null;
  timeZone: string;
}

/**
 * Why an automatic job waits, for the lists: queued (not paused) or prepared and waiting for its
 * lane (`building` with a lane) while its library is in `closed`. Null otherwise.
 */
export function runHoursHold(
  job: Pick<JobListRow, 'automatic' | 'libraryId' | 'state' | 'paused' | 'lane'>,
  closed: Map<string, Date | null>,
  timeZone: string,
): RunHoursHold | null {
  if (!job.automatic || job.paused || !closed.has(job.libraryId)) return null;
  if (job.state !== 'queued' && !(job.state === 'building' && job.lane !== null)) return null;
  return { opensAt: closed.get(job.libraryId)?.toISOString() ?? null, timeZone };
}
