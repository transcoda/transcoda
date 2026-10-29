// The Jobs page's history: saved all time, and one row of four half-height cards: the last 7
// server-local days (data saved, files done, video processed) and the encoder's last hour. Days
// come from the server in its own time zone, never the browser's.
import type { GpuLoadOutput, JobHistoryOutput } from '@transcoda/contract';
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { LoadStrip } from '../components/LoadStrip.tsx';
import { WeekBars } from '../components/WeekBars.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import { useRefetchOn } from '../hooks/useRefetchOn.ts';
import { stateChangeTracker } from '../jobs/useJobsList.ts';
import { fmtBytes } from '../lib/bytes.ts';
import { fmtStamp } from '../lib/time.ts';

const num = new Intl.NumberFormat('en-US');
const hours = (seconds: number) => `${num.format(Math.round(seconds / 3600))} h`;
const WINDOW_MS = 3_600_000;

/** The 7-day history; refetched (coalesced) when a job changes state or a run changes. */
export function useJobsHistory(): JobHistoryOutput | undefined {
  const history = useAsync(() => api.jobs.history(), []);
  const [changed] = useState(stateChangeTracker);
  useRefetchOn(
    (e) => e.type === 'run.changed' || (e.type === 'job.changed' && changed(e)),
    history.reload,
  );
  return history.data;
}

/** "Saved all time": every replaced file, with the day the first job finished on the server. */
export function AllTimeTile({ history }: { history: JobHistoryOutput | undefined }) {
  const all = history?.allTime;
  const since =
    all?.since && history
      ? fmtStamp(all.since, { relative: false, timeZone: history.timeZone })
      : null;
  const zero = all?.savedBytes === 0;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled figure group, not a form fieldset
    <div
      className={zero ? 'stat-tile is-alltime is-zero' : 'stat-tile is-alltime'}
      role="group"
      aria-label="All time"
    >
      <span className="stat-label">Saved all time</span>
      <span className="stat-value">{all ? fmtBytes(all.savedBytes) : '—'}</span>
      {all && since ? (
        <span className="stat-sub">
          {num.format(all.files)} {all.files === 1 ? 'file' : 'files'} since {since}
        </span>
      ) : null}
    </div>
  );
}

function HistoryCard({
  title,
  total,
  sub,
  className,
  children,
}: {
  title: string;
  total: string;
  sub?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled figure group, not a form fieldset
    <div
      className={className ? `history-card ${className}` : 'history-card'}
      role="group"
      aria-label={title}
    >
      <span className="history-card-title">{title}</span>
      <span className="history-card-total">
        <span>{total}</span>
        {sub ? (
          <>
            {' '}
            <small>{sub}</small>
          </>
        ) : null}
      </span>
      {children}
    </div>
  );
}

/** The kept series is neutral grey: "Kept original" is no change (convention 7). */
const KEPT_COLOR = 'var(--faint)';

/**
 * One row of four half-height cards: "Last 7 days" (data saved, files done, hours of video
 * processed) and the encoder's last hour, always shown ("idle" over a flat line when idle). Before
 * the history loads, its three cards show a dash.
 */
export function JobsHistory({ history }: { history: JobHistoryOutput | undefined }) {
  const d = history?.days ?? [];
  const sum = (f: (day: (typeof d)[number]) => number) => d.reduce((s, day) => s + f(day), 0);
  const replaced = sum((x) => x.replaced);
  const kept = sum((x) => x.kept);
  const dash = history ? null : '—';
  return (
    <section className="jobs-history" aria-labelledby="jobs-history-title">
      <h2 id="jobs-history-title" className="sr-only">
        Last 7 days
      </h2>
      <div className="history-cards">
        <HistoryCard
          title="Data saved"
          total={dash ?? fmtBytes(sum((x) => x.savedBytes))}
          {...(history ? { sub: 'this week' } : {})}
        >
          {history ? (
            <WeekBars
              label="Data saved"
              days={d.map((x) => ({ date: x.date, values: [x.savedBytes] }))}
              colors={['var(--st-replaced)']}
              parts={['saved']}
              format={fmtBytes}
            />
          ) : null}
        </HistoryCard>
        <HistoryCard title="Files done" total={dash ?? num.format(replaced + kept)}>
          {history ? (
            <>
              <WeekBars
                label="Files done"
                days={d.map((x) => ({ date: x.date, values: [x.replaced, x.kept] }))}
                colors={['var(--st-replaced)', KEPT_COLOR]}
                parts={['replaced', 'kept original']}
                format={(v) => num.format(v)}
              />
              <div className="history-legend">
                <span>
                  <i style={{ background: 'var(--st-replaced)' }} />
                  {`${num.format(replaced)} replaced`}
                </span>
                <span>
                  <i style={{ background: KEPT_COLOR }} />
                  {`${num.format(kept)} kept`}
                </span>
              </div>
            </>
          ) : null}
        </HistoryCard>
        <HistoryCard
          title="Video processed"
          total={dash ?? hours(sum((x) => x.seconds))}
          {...(history ? { sub: 'this week' } : {})}
        >
          {history ? (
            <WeekBars
              label="Hours of video processed"
              days={d.map((x) => ({ date: x.date, values: [x.seconds] }))}
              colors={['var(--muted)']}
              parts={['of video']}
              format={hours}
            />
          ) : null}
        </HistoryCard>
        <EncoderCard />
      </div>
    </section>
  );
}

/** Video-engine load per GPU, polled while the page is visible; nothing without a GPU. */
function useGpuLoad(): GpuLoadOutput | undefined {
  const [load, setLoad] = useState<GpuLoadOutput>();
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let next = 5000;
      if (document.visibilityState === 'visible') {
        try {
          const data = await api.system.gpuLoad();
          if (!alive) return;
          setLoad(data);
          next = data.intervalMs;
        } catch {
          // A missed reading: try again at the next interval.
        }
      }
      if (alive) timer = setTimeout(() => void tick(), next);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return load;
}

/**
 * "Encoder · last hour": one NVIDIA GPU shows encoder and decoder, otherwise one line per GPU.
 * Always shown: "idle" over a flat line while nothing encodes (or the server has no GPU).
 */
export function EncoderCard() {
  const load = useGpuLoad();
  const gpus = load?.gpus ?? [];
  // An Intel GPU has one video engine for both, so its encoder and decoder readings are the same.
  const one = gpus.length === 1 && gpus[0]?.id.startsWith('nvidia:') === true;
  const palette = ['var(--accent-text)', 'var(--st-kept)', 'var(--st-skipped)', 'var(--st-failed)'];
  const series = one
    ? [
        {
          id: 'encoder',
          name: 'encoder',
          color: palette[0] as string,
          points: (gpus[0]?.samples ?? []).map((s) => ({ at: s.at, value: s.encoder })),
        },
        {
          id: 'decoder',
          name: 'decoder',
          color: palette[1] as string,
          points: (gpus[0]?.samples ?? []).map((s) => ({ at: s.at, value: s.decoder })),
        },
      ]
    : gpus.map((g, i) => ({
        id: g.id,
        // The card's name is already under the chart when it is the only one.
        name: gpus.length === 1 ? 'video' : g.name,
        color: palette[i % palette.length] as string,
        points: g.samples.map((s) => ({ at: s.at, value: s.encoder })),
      }));
  const current = Math.round(gpus[0]?.samples.at(-1)?.encoder ?? 0);
  const total = !load ? '—' : current > 0 ? `now ${current}%` : 'idle';
  return (
    <HistoryCard title="Encoder · last hour" total={total} className="encoder-card">
      <div className="week-bars">
        <LoadStrip
          series={series}
          windowMs={WINDOW_MS}
          intervalMs={load?.intervalMs ?? 5000}
          now={new Date()}
          axis="ends"
          legend={
            series.length > 0 ? (
              <span className="history-legend encoder-legend">
                {series.map((s) => (
                  <span key={s.id}>
                    <i style={{ background: s.color }} />
                    {s.name}
                  </span>
                ))}
              </span>
            ) : null
          }
        />
      </div>
      {gpus.length === 1 ? <span className="encoder-gpu">{gpus[0]?.name}</span> : null}
    </HistoryCard>
  );
}
