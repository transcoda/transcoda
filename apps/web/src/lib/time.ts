// Date formatting shared by the screens (moved from TokensPage).

const dateFmt = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const dayMonthFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

export const fmtDate = (iso: string) => dateFmt.format(new Date(iso));

/** Day and short month without the year ("12 Oct" in en-GB). */
export const fmtDayMonth = (iso: string) => dayMonthFmt.format(new Date(iso));

/** "just now", "5 min ago", "3 h ago" within a day, else the date. */
export function fmtAgo(iso: string, now: Date = new Date()): string {
  const s = (now.getTime() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(iso);
}

/** Like `fmtAgo`, but without the year when it is this year ("27 Oct"): a narrow list column. */
export function fmtAgoShort(iso: string, now: Date = new Date()): string {
  const s = (now.getTime() - new Date(iso).getTime()) / 1000;
  if (s < 86400) return fmtAgo(iso, now);
  return new Date(iso).getFullYear() === now.getFullYear() ? fmtDayMonth(iso) : fmtDate(iso);
}

/** "saved just now", "saved 2 min ago", "saved 3 h ago" within a day, else "saved 12 Oct". */
export function fmtAgoLong(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  return `saved ${s < 86400 ? fmtAgo(iso) : fmtDayMonth(iso)}`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const fullFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
  hourCycle: 'h23',
});

/** "21:05" today, else "12 Oct, 21:05": a time on the job page's times line. */
export function fmtWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? timeFmt.format(d) : `${fmtDayMonth(iso)}, ${timeFmt.format(d)}`;
}

/** The exact date and time, for a title on a relative time. */
export const fmtFull = (iso: string) => fullFmt.format(new Date(iso));

/** "4 s", "1 min 2 s", "1 h 3 min": how long something took. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** A job's times as one line: "Queued 21:03 · started 21:04 · finished 21:05 · took 1 min 2 s". */
export function jobTimesLine(
  job: { queuedAt: string; startedAt: string | null; finishedAt: string | null },
  now: Date = new Date(),
): string {
  const parts = [`Queued ${fmtWhen(job.queuedAt, now)}`];
  if (job.startedAt) parts.push(`started ${fmtWhen(job.startedAt, now)}`);
  if (job.finishedAt) parts.push(`finished ${fmtWhen(job.finishedAt, now)}`);
  if (job.startedAt && job.finishedAt) {
    parts.push(`took ${fmtDuration(Date.parse(job.finishedAt) - Date.parse(job.startedAt))}`);
  }
  return parts.join(' · ');
}

/** When a job last moved: finished, else started, else queued (the Jobs row's time). */
export const jobLastTime = (job: {
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}) => job.finishedAt ?? job.startedAt ?? job.queuedAt;
