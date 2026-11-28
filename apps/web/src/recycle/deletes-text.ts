import { fmtDate } from '../lib/time.ts';

/**
 * When retention deletes a recycled file, for the Recycle page. The date is in the future
 * for every file the page lists, unless the cleanup (every 10 minutes on the server) has not
 * reached it yet, or kept it because its job is busy or its folder can't be reached: then "soon".
 */
export function deletesText(deletesAt: string, now: Date = new Date()): string {
  return Date.parse(deletesAt) > now.getTime()
    ? `Deletes on ${fmtDate(deletesAt)}`
    : 'Deletes soon';
}
