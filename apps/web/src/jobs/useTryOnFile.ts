import { createElement, type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { useToast } from '../components/Toast.tsx';
import { FilePicker } from './FilePicker.tsx';

export const FIX_ERRORS_FIRST = 'Fix the errors first';

/** The header button's word: a dirty draft is saved before the dry run. */
export function tryLabel(dirty: boolean): 'Save, then try' | 'Dry run on a file' {
  return dirty ? 'Save, then try' : 'Dry run on a file';
}

/** `?node=<id>` on the job page: the node "Try this node" was asked from. */
export function useNodeParam(): string | null {
  const search = useSearch();
  const node = new URLSearchParams(search).get('node');
  return node === null || node === '' ? null : node;
}

/**
 * "Dry run on a file" / "Try this node" / "Dry run another file": opens the file picker (title
 * "Dry run <name> on a file"); on a pick a dirty draft is saved first (`save()` answers false when it
 * did not save: the editor already shows why, and nothing is queued), then
 * `jobs.queue({ path, workflowId, dryRun: true })` (plus `workflowVersion` when `workflow.version`
 * is set: a past version) and the job page, with `?node=<id>` when a node asked; a folder that queued more than one file opens the run summary (`/runs/:runId`)
 * instead. PATH_REJECTED and other failures answer the picker (shown under its path input);
 * WORKFLOW_INVALID closes it with the toast "Fix the errors first".
 */
export function useTryOnFile(
  workflow: { id: string; name: string; version?: number },
  opts: { dirty: boolean; save(): Promise<boolean> },
): { open(nodeId?: string): void; element: JSX.Element } {
  const toast = useToast();
  const [, navigate] = useLocation();
  const [target, setTarget] = useState<{ nodeId: string | undefined } | null>(null);
  const latest = useRef(opts);
  latest.current = opts;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const open = useCallback((nodeId?: string) => setTarget({ nodeId }), []);
  const close = useCallback(() => setTarget(null), []);

  async function onPick(path: string): Promise<string | null> {
    const nodeId = target?.nodeId;
    if (latest.current.dirty) {
      const saved = await latest.current.save();
      if (!alive.current) return null;
      if (!saved) {
        setTarget(null);
        return null;
      }
    }
    const [err, out] = await safe(
      api.jobs.queue({
        path,
        workflowId: workflow.id,
        dryRun: true,
        ...(workflow.version !== undefined ? { workflowVersion: workflow.version } : {}),
      }),
    );
    if (!alive.current) return null;
    if (err) {
      if (isDefinedError(err) && err.code === 'PATH_REJECTED') return err.data.reason;
      if (isDefinedError(err) && err.code === 'WORKFLOW_INVALID') {
        setTarget(null);
        toast.error(FIX_ERRORS_FIRST);
        return null;
      }
      return describeError(err).message;
    }
    const jobId = out.jobIds[0];
    if (jobId === undefined) return 'No media file to try there';
    setTarget(null);
    // A folder that queued several files opens their run summary; one file opens its job.
    if (out.jobIds.length > 1) navigate(`/runs/${out.runId}`);
    else navigate(`/jobs/${jobId}${nodeId ? `?node=${encodeURIComponent(nodeId)}` : ''}`);
    return null;
  }

  const element = createElement(FilePicker, {
    open: target !== null,
    title: `Dry run ${workflow.name} on a file`,
    onPick,
    onClose: close,
  });
  return { open, element };
}
