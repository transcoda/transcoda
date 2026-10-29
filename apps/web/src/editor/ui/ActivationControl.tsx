import type { WorkflowSummary } from '@transcoda/contract';
import type { Issue } from '@transcoda/shared';
import { type HTMLAttributes, type RefObject, useId, useRef, useState } from 'react';
import { api, safe } from '../../api/client.ts';
import { Icon } from '../../components/Icon.tsx';
import { useToast } from '../../components/Toast.tsx';
import { countIssues } from '../model/issues.ts';
import { ActivateDialog } from './ActivateDialog.tsx';

/** Only a workflow has an active version; a sub-workflow runs as part of the workflow that runs it. */
export function hasActivation(w: Pick<WorkflowSummary, 'kind'>): boolean {
  return w.kind === 'workflow';
}

export const DEACTIVATE_FAILED = 'Could not deactivate, try again';

/** "Fix 1 error before activating" / "Fix 2 errors before activating". */
export function fixErrorsReason(n: number): string {
  return `Fix ${n} error${n === 1 ? '' : 's'} before activating`;
}

/**
 * The editor's reason not to activate the shown version. The server activates the saved version,
 * so with unsaved changes only the saved version's own validity counts (`saved`, from the
 * workflow summary): valid → nothing blocks; errors → "Fix N errors"; unknown → "Save first".
 * Without unsaved changes: the shown version's errors (`issues` describe it), then a Library
 * input naming no library (`LIBRARY_MISSING`, a warning that blocks only activation).
 */
export function activateBlocked(
  dirty: boolean,
  issues: Issue[],
  saved: { valid: boolean; errorCount: number } | null = null,
): { reason: string } | null {
  if (dirty) {
    if (saved === null) return { reason: 'Save first' };
    return saved.valid ? null : { reason: fixErrorsReason(Math.max(1, saved.errorCount)) };
  }
  const { errors } = countIssues(issues);
  if (errors > 0) return { reason: fixErrorsReason(errors) };
  if (issues.some((i) => i.code === 'LIBRARY_MISSING')) {
    return { reason: 'Pick a library that exists first' };
  }
  return null;
}

/** The pill's look for a workflow's active version (null: none), shared by the list and the editor. */
export function activationPill(active: WorkflowSummary['active']): {
  cls: 'is-off' | 'is-active' | 'is-danger';
  icon: 'pause' | 'check' | 'alert';
  text: string;
} {
  if (active === null) return { cls: 'is-off', icon: 'pause', text: 'Not active' };
  if (active.runnable)
    return { cls: 'is-active', icon: 'check', text: `Active v${active.version}` };
  return { cls: 'is-danger', icon: 'alert', text: `Active v${active.version} · can't run` };
}

/**
 * The one activation style: neutral "Not active", lime "Active v3", red "Active v3 · can't run".
 * (The eye and dashed amber belong to dry runs only.)
 */
export function ActivationPill({
  active,
  text,
  children,
  ...rest
}: {
  active: WorkflowSummary['active'];
  /**
   * Replaces the visible text (e.g. the workflows list's "Active v3" for a can't-run version, whose
   * name has a "can't run" chip); screen readers still get the full wording. The editor header
   * does not pass it.
   */
  text?: string | undefined;
  ref?: RefObject<HTMLSpanElement | null>;
} & Omit<HTMLAttributes<HTMLSpanElement>, 'className'>) {
  const pill = activationPill(active);
  return (
    <span {...rest} className={`activation-pill ${pill.cls}`}>
      <Icon name={pill.icon} size={13} />
      {text === undefined ? (
        pill.text
      ) : (
        <>
          <span aria-hidden="true">{text}</span>
          <span className="sr-only">{pill.text}</span>
        </>
      )}
      {children}
    </span>
  );
}

/**
 * What runs on files, in the editor's header: a status pill (`Active v3`, `Not active`, or
 * `Active v3 · can't run` with the first load error as its tooltip) and one button — "Activate
 * vN" on a version that is not the active one (it opens the confirmation; a person always
 * activates), "Deactivate" on the active one. `aria-disabled` with its reason as the tooltip while
 * `shown.blocked`. Deactivate is offered whenever a version is active (whichever version is shown, past views and read-only editors included: stopping real runs needs no editing); read-only hides Activate. A sub-workflow renders nothing.
 */
export function ActivationControl({
  workflow,
  shown,
  activeIssue,
  readOnly,
  onChanged,
  pillRef: pillRefProp,
}: {
  workflow: WorkflowSummary;
  /** The version the page shows (current or ?version=N) and whether it is saved and error-free. */
  shown: { version: number; blocked: { reason: string } | null };
  /** The first active issue's message; the can't-run pill's tooltip. */
  activeIssue?: string;
  readOnly: boolean;
  onChanged(summary: WorkflowSummary): void;
  /** The pill element, when the page's own dialogs also return focus to it. */
  pillRef?: RefObject<HTMLSpanElement | null>;
}) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const ownPillRef = useRef<HTMLSpanElement>(null);
  const pillRef = pillRefProp ?? ownPillRef;
  const reasonId = useId();
  if (!hasActivation(workflow)) return null;

  const active = workflow.active;
  const showsActive = active !== null && active.version === shown.version;
  const blocked = shown.blocked;

  async function deactivate() {
    if (pending) return;
    setPending(true);
    const [err, summary] = await safe(api.workflows.deactivate({ id: workflow.id }));
    setPending(false);
    if (err) {
      toast.error(DEACTIVATE_FAILED, { label: 'Try again', onClick: () => void deactivate() });
      return;
    }
    toast.success(`${summary.name} is not active`);
    onChanged(summary);
  }

  const pill = activationPill(active);

  return (
    <>
      <div className="activation-actions">
        <ActivationPill
          ref={pillRef}
          active={active}
          tabIndex={-1}
          role="status"
          title={pill.cls === 'is-danger' ? activeIssue : undefined}
          aria-label={
            pill.cls === 'is-danger' && activeIssue ? `${pill.text}: ${activeIssue}` : undefined
          }
        />
        {active !== null && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-disabled={pending || undefined}
            onClick={() => void deactivate()}
          >
            Deactivate
          </button>
        )}
        {!readOnly && !showsActive && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-disabled={blocked !== null || undefined}
            title={blocked?.reason}
            aria-describedby={blocked !== null ? reasonId : undefined}
            onClick={() => {
              if (blocked === null) setConfirming(true);
            }}
          >
            {blocked !== null && <Icon name="lock" size={13} />}
            {active !== null && shown.version < active.version
              ? `Roll back to v${shown.version}`
              : `Activate v${shown.version}`}
          </button>
        )}
        {!readOnly && !showsActive && blocked !== null && (
          <span id={reasonId} className="sr-only">
            {blocked.reason}
          </span>
        )}
      </div>
      <ActivateDialog
        open={confirming}
        workflow={workflow}
        version={shown.version}
        issues={null}
        returnFocusTo={pillRef}
        onClose={() => setConfirming(false)}
        onActivated={(summary) => {
          setConfirming(false);
          onChanged(summary);
        }}
      />
    </>
  );
}
