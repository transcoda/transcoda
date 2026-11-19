import type { JobsQueueFilesPreviewOutput, Library, WorkflowSummary } from '@transcoda/contract';
import { hourRanges, type RunHours, WEEKDAYS } from '@transcoda/shared';
import { type JSX, useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from '../components/Dialog.tsx';
import { ListboxSelect } from '../components/ListboxSelect.tsx';
import { useToast } from '../components/Toast.tsx';
import { useWorkflows } from '../hooks/useWorkflows.ts';
import { ACTIVATE_TO_RUN, recycleFolderText, runBlocked } from '../jobs/useRunOnFile.tsx';

/** What the dialog runs on: listed files by id, or every file of a show (one season). */
export type RunSelection =
  | { kind: 'files'; fileIds: string[] }
  | { kind: 'show'; show: string; season?: string };

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

function hoursText(hours: number[], wrap: boolean): string {
  if (hours.length === 0) return 'no hours';
  if (hours.length === 24) return 'all day';
  return hourRanges(hours, wrap)
    .map(([a, b]) => `${hh(a)}–${hh(b)}`)
    .join(', ');
}

/**
 * Only the time window of a library's run hours, short: "22:00–06:00", or by day,
 * "Mon–Fri 22:00–24:00; Sun 10:00–12:00". For the line "Starts in your run hours (…)".
 */
export function runHoursWindow(rh: RunHours): string {
  if (!rh.perDay) return rh.every.length === 0 ? 'no hours chosen' : hoursText(rh.every, true);
  const groups: Array<{ from: number; to: number; text: string }> = [];
  rh.days.forEach((hours, day) => {
    const text = hoursText(hours, false);
    const last = groups.at(-1);
    if (last && last.text === text && last.to === day - 1) last.to = day;
    else groups.push({ from: day, to: day, text });
  });
  const shown = groups.filter((g) => g.text !== 'no hours');
  if (shown.length === 0) return 'no hours chosen';
  return shown
    .map(({ from, to, text }) => {
      const days = from === to ? WEEKDAYS[from] : `${WEEKDAYS[from]}–${WEEKDAYS[to]}`;
      return `${days} ${text}`;
    })
    .join('; ');
}

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

function selectionKey(s: RunSelection): string {
  return s.kind === 'files' ? `f:${s.fileIds.join(',')}` : `s:${s.show}:${s.season ?? ''}`;
}

function selectionInput(s: RunSelection) {
  if (s.kind === 'files') return { fileIds: s.fileIds };
  return s.season === undefined ? { show: s.show } : { show: s.show, season: s.season };
}

type Mode = 'real' | 'dry';

/**
 * "Run a workflow on <label>": pick a workflow, real or dry run, see how many files would run
 * (files already handled are skipped unless the box is ticked), then run now or add to the
 * queue (held to the library's run hours). A real run the preview answers as a dry run (nothing
 * active any more) cannot be sent: the dialog says to activate a version. If the version goes
 * between the preview and the send, the answer is refused with a toast and the dialog stays.
 */
export function RunFilesDialog({
  open,
  library,
  selection,
  label,
  returnFocusTo,
  onClose,
}: {
  open: boolean;
  library: Library;
  selection: RunSelection;
  /** "12 files", "this season". */
  label: string;
  /** The button that opened the dialog; focus goes back to it on close. */
  returnFocusTo?: HTMLElement | null;
  onClose(): void;
}): JSX.Element {
  const toast = useToast();
  const [, navigate] = useLocation();
  const { workflows, reload } = useWorkflows();
  const runnable = (workflows ?? []).filter((w) => w.kind === 'workflow' && runBlocked(w) === null);
  const feederId = library.feeds?.workflowId;
  const [picked, setPicked] = useState<string | null>(null);
  const chosen: WorkflowSummary | null =
    runnable.find((w) => w.id === picked) ??
    runnable.find((w) => w.id === feederId) ??
    runnable[0] ??
    null;
  const [mode, setMode] = useState<Mode>('real');
  const [force, setForce] = useState(false);
  const [preview, setPreview] = useState<JobsQueueFilesPreviewOutput | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const groupId = useId();
  const request = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A fresh dialog each time it opens, with the workflow list read again (it loaded on mount).
  const mountedOpen = useRef(open);
  useEffect(() => {
    if (!open) return;
    if (!mountedOpen.current) reload();
    mountedOpen.current = false;
    setPicked(null);
    setMode('real');
    setForce(false);
    setFailed(null);
  }, [open, reload]);

  const workflowId = chosen?.id ?? null;
  const dryRun = mode === 'dry';
  const key = selectionKey(selection);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the selection's content, which is what the request depends on.
  useEffect(() => {
    if (!open || workflowId === null) return;
    const mine = ++request.current;
    setPreview(null);
    setForce(false);
    setFailed(null);
    setChecking(true);
    void safe(
      api.jobs.queueFilesPreview({
        libraryId: library.id,
        ...selectionInput(selection),
        workflowId,
        dryRun,
      }),
    ).then(([err, out]) => {
      if (!alive.current || mine !== request.current) return;
      setChecking(false);
      if (err) setFailed(describeError(err).message);
      else setPreview(out);
    });
  }, [open, library.id, key, workflowId, dryRun]);

  const handled = preview?.alreadyHandled ?? 0;
  const count = preview === null ? 0 : preview.willRun + (force ? handled : 0);
  const busy = checking || sending;
  // A real request the server would turn into a dry run (the workflow has no active version).
  const inactive = preview !== null && preview.dryRun !== dryRun;
  const canRun = !busy && !inactive && count > 0 && chosen !== null;
  // The version the files were checked against, as the server answered it.
  const version =
    preview?.workflowVersion ??
    (chosen === null ? 0 : dryRun ? chosen.currentVersion : (chosen.active?.version ?? 0));
  const held = preview?.heldByAnotherRun ?? 0;
  const notFound = preview?.notFound ?? 0;
  const skipped = preview?.skipped ?? 0;

  async function send(start: 'now' | 'runHours') {
    if (!canRun || chosen === null) return;
    setSending(true);
    setFailed(null);
    const [err, out] = await safe(
      api.jobs.queueFiles({
        libraryId: library.id,
        ...selectionInput(selection),
        workflowId: chosen.id,
        dryRun,
        force,
        priority: start === 'now' ? 1 : 0,
        start,
      }),
    );
    if (!alive.current) return;
    setSending(false);
    if (err) {
      setFailed(describeError(err).message);
      return;
    }
    if (out.dryRun && !dryRun) {
      // Nothing is active any more: read the list again so this workflow stops being offered.
      toast.error(ACTIVATE_TO_RUN);
      reload();
      return;
    }
    onClose();
    navigate(`/runs/${out.runId}`);
  }

  const summary =
    checking || preview === null
      ? workflowId === null
        ? ''
        : 'Checking the files'
      : `${files(count)} will run`;

  return (
    <Dialog
      open={open}
      title={`Run a workflow on ${label}`}
      returnFocusTo={returnFocusTo ?? null}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!canRun}
            onClick={() => void send('runHours')}
          >
            {`Add ${files(count)} to queue`}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canRun}
            aria-busy={sending}
            onClick={() => void send('now')}
          >
            {`Run ${files(count)} now`}
          </button>
          <p className="form-reason">
            {library.runHours?.enabled
              ? `Starts in your run hours (${runHoursWindow(library.runHours)})`
              : 'Added to the queue after what is already waiting'}
          </p>
        </>
      }
    >
      {workflows !== undefined && chosen === null ? (
        <p>No workflow can run for real yet. Activate a version that runs first.</p>
      ) : (
        <>
          <ListboxSelect
            label="Workflow"
            visibleLabel
            value={chosen?.id ?? ''}
            options={runnable.map((w) => ({
              value: w.id,
              label: `${w.name} v${w.active?.version ?? w.currentVersion}`,
            }))}
            onChange={setPicked}
          />
          <div role="radiogroup" aria-labelledby={`${groupId}-mode`} className="lib-dry-list">
            <span id={`${groupId}-mode`} className="field-label">
              Mode
            </span>
            <label className="lib-radio">
              <input
                type="radio"
                name={groupId}
                checked={mode === 'real'}
                onChange={() => setMode('real')}
              />
              <span>{`Run for real: originals go to ${recycleFolderText(library)}`}</span>
            </label>
            <label className="lib-radio">
              <input
                type="radio"
                name={groupId}
                checked={mode === 'dry'}
                onChange={() => setMode('dry')}
              />
              <span>Dry run: show what would happen, change nothing</span>
            </label>
          </div>
          {chosen && (
            <p className="field-hint">
              {dryRun
                ? `Dry run: v${chosen.currentVersion} (newest)`
                : `Real run: v${chosen.active?.version ?? 0} (active)`}
            </p>
          )}
          <div aria-live="polite">
            <p>{summary}</p>
            {held > 0 && (
              <p>{`${files(held)} are already queued in another run and will be skipped`}</p>
            )}
            {notFound > 0 && <p>{`${files(notFound)} can't be found and will be skipped`}</p>}
            {skipped > 0 && <p>{`${files(skipped)} will be skipped`}</p>}
          </div>
          {inactive && (
            <p className="alert alert-warning" role="alert">
              {ACTIVATE_TO_RUN}
            </p>
          )}
          {handled > 0 && chosen && (
            <label className="lib-check">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              <span>{`Also run the ${files(handled)} ${chosen.name} v${version} already handled`}</span>
            </label>
          )}
          {failed && (
            <p className="alert alert-danger" role="alert">
              {failed}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
