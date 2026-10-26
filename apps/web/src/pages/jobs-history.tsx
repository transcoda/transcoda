// The Jobs page's history: saved all time, the last 7 server-local days and the encoder's last
// hour. Days come from the server in its own time zone, never the browser's.
import type { GpuLoadOutput, JobHistoryOutput } from '@transcoda/contract';
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { LoadStrip } from '../components/LoadStrip.tsx';
import { WeekBars } from '../components/WeekBars.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import { useRefetchOn } from '../hooks/useRefetchOn.ts';
import { stateChangeTracker } from '../jobs/useJobsList.ts';
import { fmtBytes } from '../lib/bytes.ts';

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
      ? new Intl.DateTimeFormat('en-GB', {
          day: 'numeric',
          month: 'short',
          timeZone: history.timeZone,
        }).format(new Date(all.since))
      : null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled figure group, not a form fieldset
    <div className="stat-tile is-alltime" role="group" aria-label="All time">
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

function WeekCard({
  title,
  total,
  sub,
  children,
}: {
  title: string;
  total: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <div className="history-card">
      <span className="history-card-title">{title}</span>
      <span className="history-card-total">
        <span>{total}</span> <small>{sub}</small>
      </span>
      {children}
    </div>
  );
}

/** "Last 7 days": data saved, files done (replaced and kept) and hours of video processed. */
export function JobsHistory({ history }: { history: JobHistoryOutput }) {
  const d = history.days;
  const sum = (f: (day: (typeof d)[number]) => number) => d.reduce((s, day) => s + f(day), 0);
  const replaced = sum((x) => x.replaced);
  const kept = sum((x) => x.kept);
  return (
    <section className="jobs-history" aria-labelledby="jobs-history-title">
      <h2 id="jobs-history-title">Last 7 days</h2>
      <div className="history-cards">
        <WeekCard title="Data saved" total={fmtBytes(sum((x) => x.savedBytes))} sub="this week">
          <WeekBars
            label="Data saved"
            days={d.map((x) => ({ date: x.date, values: [x.savedBytes] }))}
            colors={['var(--st-replaced)']}
            parts={['saved']}
            format={fmtBytes}
          />
        </WeekCard>
        <WeekCard
          title="Files done"
          total={num.format(replaced + kept)}
          sub={`${num.format(replaced)} replaced · ${num.format(kept)} kept`}
        >
          <WeekBars
            label="Files done"
            days={d.map((x) => ({ date: x.date, values: [x.replaced, x.kept] }))}
            colors={['var(--st-replaced)', 'var(--st-kept)']}
            parts={['replaced', 'kept original']}
            format={(v) => num.format(v)}
          />
          <div className="history-legend">
            <span>
              <i style={{ background: 'var(--st-replaced)' }} />
              replaced
            </span>
            <span>
              <i style={{ background: 'var(--st-kept)' }} />
              kept original
            </span>
          </div>
        </WeekCard>
        <WeekCard
          title="Hours of video processed"
          total={hours(sum((x) => x.seconds))}
          sub="this week"
        >
          <WeekBars
            label="Hours of video processed"
            days={d.map((x) => ({ date: x.date, values: [x.seconds] }))}
            colors={['var(--muted)']}
            parts={['of video']}
            format={hours}
          />
        </WeekCard>
      </div>
    </section>
  );
}

/** NVENC/NVDEC load per GPU, polled while the page is visible; nothing without NVIDIA GPUs. */
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

/** "Encoder · last hour": one GPU shows encoder and decoder, several show an encoder line each. */
export function EncoderStrip() {
  const load = useGpuLoad();
  if (!load || load.gpus.length === 0) return null;
  const one = load.gpus.length === 1;
  const palette = ['var(--accent-text)', 'var(--st-kept)', 'var(--st-skipped)', 'var(--st-failed)'];
  const series = one
    ? [
        {
          name: 'encoder',
          color: palette[0] as string,
          points: (load.gpus[0]?.samples ?? []).map((s) => ({ at: s.at, value: s.encoder })),
        },
        {
          name: 'decoder',
          color: palette[1] as string,
          points: (load.gpus[0]?.samples ?? []).map((s) => ({ at: s.at, value: s.decoder })),
        },
      ]
    : load.gpus.map((g, i) => ({
        name: g.name,
        color: palette[i % palette.length] as string,
        points: g.samples.map((s) => ({ at: s.at, value: s.encoder })),
      }));
  const current = Math.round(load.gpus[0]?.samples.at(-1)?.encoder ?? 0);
  return (
    <section className="encoder-strip" aria-labelledby="encoder-strip-title">
      <div className="encoder-strip-head">
        <h2 id="encoder-strip-title">Encoder · last hour</h2>
        {one ? <span className="encoder-strip-gpu">{load.gpus[0]?.name}</span> : null}
        <span className="encoder-strip-now">now {current}%</span>
      </div>
      <div className="history-card">
        <LoadStrip
          series={series}
          windowMs={WINDOW_MS}
          intervalMs={load.intervalMs}
          now={new Date()}
        />
        <div className="history-legend">
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
