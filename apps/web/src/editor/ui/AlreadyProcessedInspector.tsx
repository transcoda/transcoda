import type { WorkflowSummary } from '@transcoda/contract';
import type { JsonValue, NodeInstance } from '@transcoda/shared';
import { useEffect, useId, useMemo, useRef } from 'react';
import { Icon } from '../../components/Icon.tsx';
import { setSettings } from '../model/graph-ops.ts';
import type { NodeState } from '../model/issues.ts';
import type { InspectorDispatch } from './Inspector.tsx';

/** Already processed's settings, read leniently (no zod on settings in the browser). */
export interface AlreadyProcessedSettings {
  workflowId?: string;
  version?: number;
}

export function readAlreadyProcessedSettings(settings: JsonValue): AlreadyProcessedSettings {
  const s =
    settings !== null && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const { workflowId, version } = s;
  return {
    ...(typeof workflowId === 'string' && workflowId !== '' ? { workflowId } : {}),
    ...(typeof version === 'number' && Number.isInteger(version) && version >= 1
      ? { version }
      : {}),
  };
}

const THIS = '';

/**
 * Already processed's settings: the workflow picker ("This workflow", then the other workflows by
 * name, as the Run node picks its sub-workflow) and "Any version" or one version number. "This
 * workflow" is the workflow the job runs, also when the node sits in a sub-workflow.
 */
export function AlreadyProcessedInspector({
  instance,
  state,
  workflows,
  selfId,
  readOnly,
  dispatch,
  focusField = null,
}: {
  instance: NodeInstance;
  state: NodeState;
  /** `workflows.list` (sub-workflows are left out: their jobs are their parent's). */
  workflows: WorkflowSummary[];
  /** The workflow being edited ("This workflow" covers it). */
  selfId: string;
  readOnly: boolean;
  dispatch: InspectorDispatch;
  focusField?: string | null;
}) {
  const workflowFieldId = useId();
  const versionFieldId = useId();
  const pickerRef = useRef<HTMLSelectElement>(null);
  const versionRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (focusField === 'workflowId') pickerRef.current?.focus();
    if (focusField === 'version') versionRef.current?.focus();
  }, [focusField]);
  const id = instance.id;
  const settings = readAlreadyProcessedSettings(instance.settings);
  const { workflowId, version } = settings;

  const options = useMemo(
    () =>
      workflows
        .filter((w) => w.kind === 'workflow' && w.id !== selfId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [workflows, selfId],
  );
  const chosen = workflowId === undefined ? undefined : options.find((w) => w.id === workflowId);
  const missing = workflowId !== undefined && workflowId !== selfId && chosen === undefined;
  // The newest version to offer: the chosen workflow's, or this one's when it is a workflow.
  const self = workflows.find((w) => w.id === selfId);
  const latest =
    workflowId === undefined || workflowId === selfId
      ? self?.kind === 'workflow'
        ? self.currentVersion
        : null
      : (chosen?.currentVersion ?? null);
  const versions = Array.from(
    { length: Math.max(latest ?? 0, version ?? 0) },
    (_, i) => i + 1,
  ).reverse();

  const write = (next: AlreadyProcessedSettings) =>
    dispatch((g) => setSettings(g, id, { ...next }), {
      coalesce: 'settings',
      key: id,
    });
  const issueOf = (key: string) => state.fieldIssues.get(key)?.[0] ?? null;
  const workflowIssue = issueOf('workflowId');
  const versionIssue = issueOf('version');

  return (
    <div className="node-form already-processed-inspector">
      <div className={workflowIssue ? 'tc-field has-issue' : 'tc-field'} data-field="workflowId">
        <div className="tc-field-head">
          <label htmlFor={workflowFieldId} className="tc-field-label">
            Workflow
          </label>
        </div>
        <select
          id={workflowFieldId}
          ref={pickerRef}
          className="input tc-input"
          value={workflowId ?? THIS}
          disabled={readOnly}
          aria-describedby={`${workflowFieldId}-hint`}
          aria-invalid={workflowIssue ? true : undefined}
          onChange={(e) => {
            const next = e.target.value;
            if (next === (workflowId ?? THIS)) return;
            // Another workflow's version numbers are its own: the version starts over at any.
            write(next === THIS ? {} : { workflowId: next });
          }}
        >
          <option value={THIS}>This workflow</option>
          {missing && <option value={workflowId}>{`${workflowId} (no longer exists)`}</option>}
          {options.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <span id={`${workflowFieldId}-hint`} className="tc-field-hint">
          {workflowId === undefined
            ? 'The workflow this file is running through (also from inside a sub-workflow)'
            : 'Yes when that workflow already did, kept or left this file, or this file is its output'}
        </span>
        {workflowIssue && (
          <p className="tc-field-issue">
            <Icon name="alert" size={14} round />
            {workflowIssue.message}
          </p>
        )}
      </div>

      <div className={versionIssue ? 'tc-field has-issue' : 'tc-field'} data-field="version">
        <div className="tc-field-head">
          <label htmlFor={versionFieldId} className="tc-field-label">
            Version
          </label>
        </div>
        {versions.length > 0 ? (
          <select
            id={versionFieldId}
            ref={versionRef}
            className="input tc-input"
            value={version === undefined ? '' : String(version)}
            disabled={readOnly}
            aria-invalid={versionIssue ? true : undefined}
            onChange={(e) => {
              const v = e.target.value;
              write({
                ...(workflowId !== undefined ? { workflowId } : {}),
                ...(v === '' ? {} : { version: Number(v) }),
              });
            }}
          >
            <option value="">Any version</option>
            {versions.map((v) => (
              <option key={v} value={String(v)}>
                v{v}
              </option>
            ))}
          </select>
        ) : (
          // The versions are not known here (a sub-workflow's "This workflow"): a number to type.
          <input
            id={versionFieldId}
            className="input tc-input"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder="Any version"
            value={version ?? ''}
            readOnly={readOnly}
            aria-invalid={versionIssue ? true : undefined}
            onChange={(e) => {
              const n = Number(e.target.value);
              write({
                ...(workflowId !== undefined ? { workflowId } : {}),
                ...(e.target.value !== '' && Number.isInteger(n) && n >= 1 ? { version: n } : {}),
              });
            }}
          />
        )}
        {versionIssue && (
          <p className="tc-field-issue">
            <Icon name="alert" size={14} round />
            {versionIssue.message}
          </p>
        )}
      </div>
    </div>
  );
}
