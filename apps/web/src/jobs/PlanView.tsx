import type { JobResult, WorkflowActive } from '@transcoda/contract';
import type { JobPlan, ProbeSummary } from '@transcoda/shared';
import { useId } from 'react';
import { Icon } from '../components/Icon.tsx';
import { fmtBytes, fmtPercent } from '../lib/bytes.ts';
import {
  containerLine,
  dropLine,
  keptSummary,
  type LanguageGroup,
  languageNameOf,
  type PlanStream,
  shownDrops,
  sidecarSummary,
  sizeLine,
  trackLabel,
  wouldDo,
} from './planText.ts';

const RESULT: Record<PlanStream['action'], { word: string; icon: 'check' | 'cross' | 'replace' }> =
  {
    keep: { word: 'Keep', icon: 'check' },
    drop: { word: 'Drop', icon: 'cross' },
    convert: { word: 'Convert', icon: 'replace' },
  };

const DONE_WORD: Record<PlanStream['action'], string> = {
  keep: 'kept',
  drop: 'dropped',
  convert: 'converted',
};

/** Stable keys: a stream the model adds shares its source's index, so count repeats ("3.1"). */
function keyed(streams: PlanStream[]): Array<{ s: PlanStream; key: string }> {
  const seen = new Map<number, number>();
  return streams.map((s) => {
    const n = seen.get(s.index) ?? 0;
    seen.set(s.index, n + 1);
    return { s, key: `${s.index}.${n}` };
  });
}

const yesNo = (b: boolean) => (b ? 'Yes' : 'No');

/**
 * The engine's own default-flag rules (`normalizeDefaults`), appended to a stream's note after
 * "; ". They change a flag no node asked for, so the Default cell says why; the rest of a note
 * ("default", a language code) repeats the table and stays out.
 */
const DEFAULT_RULE =
  /^(only one default (audio|subtitle) track|no audio track was default|mp4 cannot have no default subtitle)$/;

function defaultWhy(note: string): string | null {
  return note.split('; ').find((part) => DEFAULT_RULE.test(part)) ?? null;
}

/** before → after of the default flag: "No", "No → Yes", "Yes → Gone" (a dropped default). */
function DefaultCell({ s }: { s: PlanStream }) {
  const before = s.default.before;
  if (s.action === 'drop' && before) {
    return (
      <span className="plan-default">
        <b className="plan-default-was">Yes</b>{' '}
        <Icon name="chevron-right" size={14} strokeWidth={2.6} />{' '}
        <span className="muted">Gone</span>
      </span>
    );
  }
  const after = s.action === 'drop' ? false : s.default.after;
  if (before === after) return <span className="muted">{yesNo(before)}</span>;
  const why = s.action === 'drop' ? null : defaultWhy(s.note);
  return (
    <span className="plan-default">
      <span className="muted">{yesNo(before)}</span>{' '}
      <Icon name="chevron-right" size={14} strokeWidth={2.6} />{' '}
      <b className={after ? 'plan-default-now' : undefined}>{yesNo(after)}</b>
      {why && <span className="plan-default-why">{why}</span>}
    </span>
  );
}

function ResultChip({ action }: { action: PlanStream['action'] }) {
  const r = RESULT[action];
  return (
    <span className={`plan-result plan-result-${action}`}>
      <Icon name={r.icon} size={13} strokeWidth={2.8} />
      {r.word}
    </span>
  );
}

function GroupRows({ group, probe }: { group: LanguageGroup; probe: ProbeSummary | null }) {
  const n = group.streams.length;
  return (
    <>
      {keyed(group.streams).map(({ s, key }, i) => (
        <tr key={key} className={s.action === 'drop' ? 'plan-row is-drop' : 'plan-row'}>
          {i === 0 && (
            <th scope="row" rowSpan={n} className="plan-lang">
              {group.name}{' '}
              {group.language && <span className="plan-lang-code mono">{group.language}</span>}
              {group.original && <span className="plan-original mono">Original</span>}
            </th>
          )}
          {i > 0 && (
            // The phone cards have no row span: each card names its language (the th covers it
            // on the wide table; this cell is hidden there and from readers).
            <td className="plan-lang-repeat" aria-hidden="true">
              {group.name}
            </td>
          )}
          <td className="plan-cell plan-track mono" data-label="Tracks">
            {trackLabel(s, probe)}
          </td>
          <td className="plan-cell plan-cell-default" data-label="Default">
            <DefaultCell s={s} />
          </td>
          <td className="plan-cell plan-cell-result" data-label="Result">
            <ResultChip action={s.action} />
          </td>
        </tr>
      ))}
    </>
  );
}

function LanguageTable({
  type,
  title,
  plan,
  probe,
}: {
  type: 'audio' | 'subtitle';
  title: string;
  plan: JobPlan;
  probe: ProbeSummary | null;
}) {
  const headingId = useId();
  const streams = plan.streams.filter((s) => s.type === type);
  if (streams.length === 0) return null;
  const { rows, folded } = shownDrops(streams, type);
  const line = dropLine(folded);
  return (
    <section aria-labelledby={headingId} className="plan-card">
      <div className="plan-card-head">
        <h2 id={headingId}>{title}</h2>
        <span className="muted">{keptSummary(streams, type)}</span>
      </div>
      <div className="plan-table-wrap">
        <table className="plan-table">
          <colgroup>
            <col className="plan-col-lang" />
            <col className="plan-col-track" />
            <col className="plan-col-default" />
            <col className="plan-col-result" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Language</th>
              <th scope="col">Tracks</th>
              <th scope="col">Default</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <GroupRows key={g.language ?? ''} group={g} probe={probe} />
            ))}
            {line && (
              <tr className="plan-row">
                <td colSpan={4} className="plan-drop-cell">
                  <details className="plan-drops">
                    <summary>
                      <Icon name="chevron-right" size={14} strokeWidth={2.6} />
                      <span>{line}</span>
                    </summary>
                    <div className="plan-drop-list">
                      {keyed(folded).map(({ s, key }) => (
                        <span key={key} className="plan-drop-chip">
                          {languageNameOf(s.language)}{' '}
                          <span className="mono faint">{trackLabel(s, probe).split(' · ')[0]}</span>
                        </span>
                      ))}
                    </div>
                  </details>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const SIDECAR_RESULT = {
  embed: { word: 'Embed', icon: 'check', cls: 'keep' },
  drop: { word: 'Drop', icon: 'cross', cls: 'drop' },
} as const;

/** Subtitle files read next to the video: what each one becomes. Not shown without any. */
function SidecarTable({ plan }: { plan: JobPlan }) {
  const headingId = useId();
  const sidecars = plan.sidecars ?? [];
  if (sidecars.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="plan-card plan-sidecars">
      <div className="plan-card-head">
        <h2 id={headingId}>Subtitle files</h2>
        <span className="muted">{sidecarSummary(plan)}</span>
      </div>
      <div className="plan-table-wrap">
        <table className="plan-table">
          <colgroup>
            <col className="plan-col-file" />
            <col className="plan-col-lang" />
            <col className="plan-col-flag" />
            <col className="plan-col-flag" />
            <col className="plan-col-result" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Language</th>
              <th scope="col">Forced</th>
              <th scope="col">SDH</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {sidecars.map((s, i) => {
              const r = SIDECAR_RESULT[s.action];
              return (
                <tr
                  // biome-ignore lint/suspicious/noArrayIndexKey: file names can repeat; the list is static
                  key={`${i}-${s.file}`}
                  className={s.action === 'drop' ? 'plan-row is-drop' : 'plan-row'}
                >
                  <th scope="row" className="plan-lang plan-sidecar-file mono">
                    {s.file}
                    {s.note && <span className="plan-sidecar-note">{s.note}</span>}
                  </th>
                  <td className="plan-cell" data-label="Language">
                    {languageNameOf(s.language)}
                  </td>
                  <td className="plan-cell" data-label="Forced">
                    <span className="muted">{yesNo(s.forced)}</span>
                  </td>
                  <td className="plan-cell" data-label="SDH">
                    <span className="muted">{yesNo(s.sdh)}</span>
                  </td>
                  <td className="plan-cell plan-cell-result" data-label="Result">
                    <span className={`plan-result plan-result-${r.cls}`}>
                      <Icon name={r.icon} size={13} strokeWidth={2.8} />
                      {r.word}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OtherStreams({ plan, probe }: { plan: JobPlan; probe: ProbeSummary | null }) {
  const headingId = useId();
  const others = plan.streams.filter((s) => s.type === 'video' || s.type === 'attachment');
  return (
    <section aria-labelledby={headingId} className="plan-card plan-other">
      <h2 id={headingId}>Video and attachments</h2>
      <div className="plan-other-list">
        {keyed(others).map(({ s, key }) => (
          <span key={key} className="plan-other-item">
            <b>{s.type === 'attachment' && s.title ? s.title : trackLabel(s, probe)}</b> ·{' '}
            <span className="muted">{s.note || DONE_WORD[s.action]}</span>
          </span>
        ))}
        <span className="plan-other-item">
          <b>Container</b> {containerLine(plan)}
        </span>
      </div>
    </section>
  );
}

/**
 * The dry-run plan (screen 06): what the workflow would do to this file, per stream, without
 * having touched it. The "Nothing on disk changed" line and the "Would do" / "Size (est.)" tiles
 * (amber, the dry-run tone; "Size · Now 2.41 GB → ?" while there is no estimate; a test encode's
 * measured size is plain "Size", "Now 2.41 GB → …" while it measures and "Now 2.41 GB" when it
 * ended without a measurement), the audio and subtitle
 * tables by language (dropped languages that lose the default keep a row, the rest fold into the
 * drop line), video and attachments with the engine's note, the container line, and "Activate
 * v<n> of <name>…" (hidden while that version is active, and until the workflow has loaded) and
 * "Dry run another file".
 */
export function PlanView({
  plan,
  probe,
  result,
  measured = false,
  workflow,
  onActivate,
  onTryAnother,
}: {
  plan: JobPlan;
  probe: ProbeSummary | null;
  /** The dry run's result (estimated size); null while the job has not finished. */
  result: JobResult | null;
  /** A test encode: the result carries the measured output size, not an estimate. */
  measured?: boolean;
  /** `active`: undefined while the workflow has not loaded (the button waits), null: none active. */
  workflow: {
    id: string;
    name: string;
    version: number;
    active: WorkflowActive | undefined;
  };
  onActivate(): void;
  onTryAnother(): void;
}) {
  const before = result?.beforeBytes ?? probe?.sizeBytes ?? null;
  const after = !plan.rewrite
    ? null
    : measured
      ? (result?.afterBytes ?? null)
      : (result?.estimatedBytes ?? null);
  // A finished rewrite without an estimate (the engine has no history to go by yet).
  const noEstimate = !measured && plan.rewrite && result !== null && after === null;
  // A test encode still running, and one that ended without a measured size (failed, cancelled).
  const measuring = measured && plan.rewrite && result === null;
  const notMeasured = measured && plan.rewrite && result !== null && after === null;
  const now =
    before === null ? null : measuring ? '→ …' : noEstimate ? '→ ?' : notMeasured ? '' : null;
  const srNote = measuring
    ? '(measuring)'
    : noEstimate
      ? '(no estimate yet)'
      : notMeasured
        ? '(not measured)'
        : null;
  const percent = before !== null && after !== null ? fmtPercent(before, after) : null;
  return (
    <div className="plan">
      <div className="plan-hero">
        {/* The one "Dry run" marker is the job's state chip in the header; this says what it means. */}
        <span className="plan-eyebrow mono">Nothing on disk changed</span>
        <div className="plan-tiles">
          <div className="plan-tile">
            <span className="plan-tile-label mono">Would do</span>
            <span className="plan-tile-value">{wouldDo(plan)}</span>
          </div>
          <div className="plan-tile-sep" aria-hidden="true" />
          <div className="plan-tile">
            <span className="plan-tile-label mono">
              {noEstimate || measured ? 'Size' : 'Size (est.)'}
            </span>
            <span className="plan-tile-value">
              {now !== null && before !== null ? (
                <>
                  <span className="plan-tile-now">Now</span>{' '}
                  {`${fmtBytes(before)}${now ? ` ${now}` : ''}`}
                </>
              ) : (
                sizeLine(before, after)
              )}
            </span>
            {srNote && <span className="sr-only">{srNote}</span>}
          </div>
          {percent !== null && percent !== '—' && <div className="plan-percent">{percent}</div>}
        </div>
        {/* The next step sits with the verdict, not below the track tables. */}
        <div className="plan-actions">
          {workflow.active !== undefined && workflow.active?.version !== workflow.version && (
            <button type="button" className="btn btn-primary btn-lg" onClick={onActivate}>
              Activate v{workflow.version} of {workflow.name}…
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onTryAnother}>
            Dry run another file
          </button>
        </div>
      </div>
      <LanguageTable type="audio" title="Audio" plan={plan} probe={probe} />
      <LanguageTable type="subtitle" title="Subtitles" plan={plan} probe={probe} />
      <SidecarTable plan={plan} />
      <OtherStreams plan={plan} probe={probe} />
    </div>
  );
}
