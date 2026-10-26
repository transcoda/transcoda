import type { SubworkflowSetting, WorkflowSummary } from '@transcoda/contract';
import {
  type JsonValue,
  type NodeInstance,
  RUN_SUBWORKFLOW_TYPE,
  SUBWORKFLOW_END_TYPE,
  SUBWORKFLOW_START_TYPE,
} from '@transcoda/shared';
import { useEffect, useId, useMemo, useRef } from 'react';
import { api } from '../../api/client.ts';
import { describeError } from '../../api/errors.ts';
import { Icon } from '../../components/Icon.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useAsync } from '../../hooks/useAsync.ts';
import { GuardedLink } from '../../lib/navigation.tsx';
import { setOverride, setPinnedVersion, setSettings } from '../model/graph-ops.ts';
import type { NodeState } from '../model/issues.ts';
import type { InspectorDispatch } from './Inspector.tsx';
import { OverridesEditor } from './OverridesEditor.tsx';

type JsonObject = { [key: string]: JsonValue };

function isObject(v: JsonValue | undefined): v is JsonObject {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
}

/** A Run node's settings, read leniently (no zod on settings in the browser). */
export interface RunSettings {
  subworkflowId?: string;
  version?: number;
  overrides: Record<string, JsonValue>;
}

export function readRunSettings(settings: JsonValue): RunSettings {
  const s = isObject(settings) ? settings : {};
  const id = s.subworkflowId;
  const version = s.version;
  return {
    ...(typeof id === 'string' && id !== '' ? { subworkflowId: id } : {}),
    ...(typeof version === 'number' && Number.isInteger(version) && version >= 1
      ? { version }
      : {}),
    overrides: isObject(s.overrides) ? s.overrides : {},
  };
}

/** Node types a parent can never override (the server excludes them; the editor never offers them). */
const NOT_OVERRIDABLE: ReadonlySet<string> = new Set([
  SUBWORKFLOW_START_TYPE,
  SUBWORKFLOW_END_TYPE,
  RUN_SUBWORKFLOW_TYPE,
]);

/** `pin` is the `<subworkflowId>@<version>` the answer is for. */
type Child =
  | { kind: 'none' }
  | { kind: 'missing'; pin: string }
  | { kind: 'loaded'; pin: string; settings: SubworkflowSetting[] };

const NONE: Child = { kind: 'none' };
const MISSING = 'Sub-workflow no longer exists';

/**
 * The Run sub-workflow node's settings (design: "Run sub-workflow inspector"): the sub-workflow
 * picker, the pinned version with "Update to vN", "Open sub-workflow" and the overrides editor
 * for the pinned version's settings. A deleted sub-workflow (NOT_FOUND) shows "Sub-workflow no
 * longer exists" with the picker still usable (Review Focus 4).
 */
export function RunSubworkflowInspector({
  instance,
  state,
  subworkflows,
  readOnly,
  dispatch,
  focusField = null,
}: {
  instance: NodeInstance;
  state: NodeState;
  subworkflows: WorkflowSummary[];
  readOnly: boolean;
  dispatch: InspectorDispatch;
  /** A setting path to focus (once per change): the card's summary asks for the picker. */
  focusField?: string | null;
}) {
  const pickerId = useId();
  const pickerRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (focusField === 'subworkflowId' || focusField === 'version') pickerRef.current?.focus();
  }, [focusField]);
  const id = instance.id;
  const { subworkflowId, version, overrides } = readRunSettings(instance.settings);
  const summary = subworkflows.find((w) => w.id === subworkflowId);
  const pin = `${subworkflowId}@${version}`;

  const child = useAsync<Child>(async () => {
    if (subworkflowId === undefined || version === undefined) return NONE;
    try {
      const w = await api.workflows.get({ id: subworkflowId, version });
      // Only settings of the child's own nodes; never its start/end or nested Run nodes.
      const types = new Map(w.graph.nodes.map((n) => [n.id, n.type] as const));
      const settings = (w.settings ?? []).filter((s) => {
        const type = types.get(s.nodeId);
        return type !== undefined && !NOT_OVERRIDABLE.has(type);
      });
      return { kind: 'loaded', pin, settings };
    } catch (e) {
      if (describeError(e).code === 'NOT_FOUND') return { kind: 'missing', pin };
      throw e;
    }
  }, [subworkflowId, version]);
  // While another pin loads, the previous pin's answer is not this one's (its settings would
  // write keys of the wrong child).
  const loaded = child.data?.kind !== 'none' && child.data?.pin === pin ? child.data : undefined;

  const missing =
    loaded?.kind === 'missing' || state.issues.some((i) => i.code === 'SUBWORKFLOW_MISSING');

  const options = useMemo(() => {
    const subs = subworkflows
      .filter((w) => w.kind === 'subworkflow')
      .sort((a, b) => a.name.localeCompare(b.name));
    const current = subs.find((w) => w.id === subworkflowId);
    return current ? [current, ...subs.filter((w) => w !== current)] : subs;
  }, [subworkflows, subworkflowId]);

  const latest = Math.max(state.outdatedPinTo ?? 0, summary?.currentVersion ?? 0);
  const update = version !== undefined && latest > version ? latest : null;

  const overrideIssues = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of state.issues) {
      const path = i.settingPath;
      if (i.code !== 'INVALID_OVERRIDE' || !path?.startsWith('overrides.')) continue;
      const key = path.slice('overrides.'.length);
      if (!map.has(key)) map.set(key, i.message);
    }
    return map;
  }, [state.issues]);
  const pickerIssue =
    state.fieldIssues.get('subworkflowId')?.[0] ?? state.fieldIssues.get('version')?.[0];

  function pick(nextId: string) {
    const next = subworkflows.find((w) => w.id === nextId);
    if (!next || nextId === subworkflowId) return;
    dispatch((g) =>
      setSettings(g, id, { subworkflowId: next.id, version: next.currentVersion, overrides: {} }),
    );
  }

  return (
    <div className="node-form run-inspector">
      <div className={pickerIssue ? 'tc-field has-issue' : 'tc-field'} data-field="subworkflowId">
        <div className="tc-field-head">
          <label htmlFor={pickerId} className="tc-field-label">
            Sub-workflow
          </label>
        </div>
        <select
          id={pickerId}
          ref={pickerRef}
          className="input tc-input"
          value={subworkflowId ?? ''}
          disabled={readOnly}
          aria-invalid={pickerIssue ? true : undefined}
          onChange={(e) => pick(e.target.value)}
        >
          {subworkflowId === undefined && (
            <option value="" disabled>
              Choose a sub-workflow
            </option>
          )}
          {subworkflowId !== undefined && !options.some((w) => w.id === subworkflowId) && (
            <option value={subworkflowId}>
              {missing ? `${subworkflowId} (no longer exists)` : subworkflowId}
            </option>
          )}
          {options.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        {pickerIssue && (
          <p className="tc-field-issue">
            <Icon name="alert" size={14} round />
            {pickerIssue.message}
          </p>
        )}
      </div>

      {subworkflowId !== undefined && version !== undefined && (
        <div className="run-pin">
          <p className="run-pin-line">
            {update === null ? `v${version} pinned` : `v${version} pinned · v${update} available`}
          </p>
          <div className="run-pin-actions">
            {update !== null && (
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={readOnly}
                onClick={() => dispatch((g) => setPinnedVersion(g, id, update))}
              >
                Update to v{update}
              </button>
            )}
            {!missing && (
              <GuardedLink
                href={`/workflows/${encodeURIComponent(subworkflowId)}?version=${version}`}
                className="run-open"
              >
                Open sub-workflow
              </GuardedLink>
            )}
          </div>
        </div>
      )}

      {subworkflowId !== undefined && version !== undefined && (
        <div className="run-overrides">
          <p className="run-overrides-title">Overrides</p>
          {missing ? (
            <p className="run-missing">
              <Icon name="alert" size={14} round />
              {MISSING}
            </p>
          ) : child.error && !child.loading ? (
            <p className="run-load-failed">
              <span>Could not load its settings: {describeError(child.error).message}</span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={child.reload}>
                Try again
              </button>
            </p>
          ) : loaded?.kind === 'loaded' ? (
            <OverridesEditor
              key={pin}
              settings={loaded.settings}
              overrides={overrides}
              issues={overrideIssues}
              readOnly={readOnly}
              onSet={(key, value) =>
                dispatch((g) => setOverride(g, id, key, value), {
                  coalesce: 'settings',
                  key: `${id}:overrides.${key}`,
                })
              }
            />
          ) : (
            <Loading inline label="Loading settings…" />
          )}
        </div>
      )}
    </div>
  );
}
