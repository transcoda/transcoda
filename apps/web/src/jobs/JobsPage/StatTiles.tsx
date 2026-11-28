import { useState } from 'react';
import { api } from '../../api/client.ts';
import { StatTile } from '../../components/StatTile.tsx';
import { useAsync } from '../../hooks/use-async.ts';
import { useRefetchOn } from '../../hooks/use-refetch-on.ts';
import { fmtBytes } from '../../lib/bytes.ts';
import { stateChangeTracker } from '../use-jobs-list.ts';

const num = new Intl.NumberFormat('en-US');

/**
 * Today's totals, "today" being the server's local day (as the history's last bar); refetched
 * (coalesced) when a job changes state or a run changes.
 */
export function useTodayStats() {
  const stats = useAsync(() => api.jobs.stats({}), []);
  const [changed] = useState(stateChangeTracker);
  useRefetchOn(
    (e) => e.type === 'run.changed' || (e.type === 'job.changed' && changed(e)),
    stats.reload,
  );
  return stats.data;
}

/**
 * The four "Today" tiles. Without `onSelect` (phone) they are plain figures; with it (desktop)
 * Queued, Failed and Needs attention are buttons that apply the filter of the same name, and the
 * active one is `aria-pressed` (one ring and a check). "Saved today" has no filter. Plain tiles, no
 * fills (convention 6); nothing saved and nothing queued are dimmed at zero, while zero failed and
 * zero needing attention are good news and stay bright. "Needs attention" leads (first, wider, a
 * larger figure): it is the one count that asks you to do something about a file.
 */
export function StatTiles({
  stats,
  problemCount,
  active,
  onSelect,
}: {
  stats: ReturnType<typeof useTodayStats>;
  problemCount: number | null;
  /** The label of the active filter chip. */
  active?: string | undefined;
  onSelect?(filterLabel: string): void;
}) {
  const tiles: Array<{
    label: string;
    filter: string | null;
    value: string;
    zero: boolean;
    className?: string;
  }> = [
    {
      label: 'Needs attention',
      filter: 'Needs attention',
      value: problemCount === null ? '—' : num.format(problemCount),
      zero: false,
      className: 'is-lead',
    },
    {
      label: 'Saved today',
      filter: null,
      // Files that came out bigger are growth, said plainly: never a "−104 B" saving in green.
      value: !stats
        ? '—'
        : stats.savedBytes < 0
          ? `Grew ${fmtBytes(-stats.savedBytes)}`
          : fmtBytes(stats.savedBytes),
      zero: stats?.savedBytes === 0,
      // A figure, not a filter: a plain tile whose value is the accent colour (a saving only).
      ...((stats?.savedBytes ?? 0) >= 0 ? { className: 'has-accent-value' } : {}),
    },
    {
      label: 'Queued',
      filter: 'Queued',
      value: stats ? num.format(stats.queued) : '—',
      zero: stats?.queued === 0,
    },
    {
      label: 'Failed',
      filter: 'Failed',
      value: stats ? num.format(stats.failed) : '—',
      zero: false,
    },
  ];
  return (
    <ul className="stat-tiles" aria-label="Today">
      {tiles.map((t) => {
        const filter = t.filter;
        const clickable = onSelect !== undefined && filter !== null;
        return (
          <StatTile
            key={t.label}
            label={t.label}
            value={t.value}
            zero={t.zero}
            {...(t.className ? { className: t.className } : {})}
            {...(clickable
              ? {
                  onClick: () => onSelect(filter),
                  pressed: active === filter,
                  buttonLabel: `${t.label}: ${t.value}, show these jobs`,
                }
              : {})}
          />
        );
      })}
    </ul>
  );
}
