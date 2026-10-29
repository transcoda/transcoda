import type { WorkflowSummary } from '@transcoda/contract';
import type { Issue } from '@transcoda/shared';
import { type HTMLAttributes, type ReactNode, type RefObject, useState } from 'react';
import { api, safe } from '../../api/client.ts';
import { Icon } from '../../components/Icon.tsx';
import { useToast } from '../../components/Toast.tsx';
import { countIssues } from '../model/issues.ts';
import { ActivateDialog } from './ActivateDialog.tsx';
import type { OverflowItem } from './EditorHeader.tsx';

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
 * (The eye and dashed amber belong to dry runs only.) The editor folds the same state into its
 * version pill (`versionPill` in EditorHeader).
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
 * What runs on files, as the editor's "More actions" items: "Activate vN" ("Roll back to vN" below
 * the active version) on a version that is not the active one (it opens the confirmation; a person
 * always activates) and "Deactivate" while a version is active. Activate is blocked (aria-disabled,
 * its reason as the tooltip) while `shown.blocked`. Deactivate is offered whenever a version is
 * active (whichever version is shown, past views and read-only editors included: stopping real
 * runs needs no editing); read-only hides Activate. A sub-workflow has no items. The state itself
 * reads in the header's version pill; `dialog` is the confirmation, rendered by the caller.
 */
export function useActivation({
  workflow,
  shown,
  readOnly,
  onChanged,
  returnFocusTo,
}: {
  /** null while the page is still loading: no items. */
  workflow: WorkflowSummary | null;
  /** The version the page shows (current or ?version=N) and whether it is saved and error-free. */
  shown: { version: number; blocked: { reason: string } | null };
  readOnly: boolean;
  onChanged(summary: WorkflowSummary): void;
  /** Where focus goes when the confirmation closes (the menu that opened it is gone by then). */
  returnFocusTo?: RefObject<HTMLElement | null>;
}): { items: OverflowItem[]; dialog: ReactNode } {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  if (workflow === null || !hasActivation(workflow)) return { items: [], dialog: null };

  const workflowId = workflow.id;
  const active = workflow.active;
  const showsActive = active !== null && active.version === shown.version;
  const blocked = shown.blocked;

  async function deactivate() {
    if (pending) return;
    setPending(true);
    const [err, summary] = await safe(api.workflows.deactivate({ id: workflowId }));
    setPending(false);
    if (err) {
      toast.error(DEACTIVATE_FAILED, { label: 'Try again', onClick: () => void deactivate() });
      return;
    }
    toast.success(`${summary.name} is not active`);
    onChanged(summary);
  }

  const items: OverflowItem[] = [];
  if (!readOnly && !showsActive) {
    items.push({
      label:
        active !== null && shown.version < active.version
          ? `Roll back to v${shown.version}`
          : `Activate v${shown.version}`,
      onSelect: () => setConfirming(true),
      blockedReason: blocked?.reason,
    });
  }
  if (active !== null) {
    items.push({ label: 'Deactivate', onSelect: () => void deactivate(), disabled: pending });
  }

  const dialog = (
    <ActivateDialog
      open={confirming}
      workflow={workflow}
      version={shown.version}
      issues={null}
      {...(returnFocusTo ? { returnFocusTo } : {})}
      onClose={() => setConfirming(false)}
      onActivated={(summary) => {
        setConfirming(false);
        onChanged(summary);
      }}
    />
  );
  return { items, dialog };
}
