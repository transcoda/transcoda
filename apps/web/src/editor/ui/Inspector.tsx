import type { NodeInfo, WorkflowSummary } from '@transcoda/contract';
import {
  ALREADY_PROCESSED_TYPE,
  type Issue,
  type JsonValue,
  linkedNodes,
  type NodeInstance,
  RUN_SUBWORKFLOW_TYPE,
} from '@transcoda/shared';
import { useEffect, useId, useMemo, useState } from 'react';
import { KIND_WORD, KindEyebrow } from '../../components/Chips.tsx';
import { Disclosure } from '../../components/Disclosure.tsx';
import { Icon } from '../../components/Icon.tsx';
import type { Catalog } from '../../hooks/useCatalog.ts';
import { BADGE_ICON } from '../flow/badges.ts';
import { kindClassOf } from '../flow/TcNode.tsx';
import type { EditorState } from '../model/editor-state.ts';
import {
  DEFAULT_GROUP_NAME,
  duplicateNode,
  MAX_LABEL_LENGTH,
  removeNodes,
  renameGroup,
  setGroupCollapsed,
  setLabel,
  setSettings,
  toggleBypass,
  ungroup,
} from '../model/graph-ops.ts';
import { type NodeState, nodeStateFor, stateTypeFor } from '../model/issues.ts';
import {
  linkSetting,
  removeValue,
  removeValuesCard,
  renameValue,
  setGroupNote,
  setValue,
  shareSetting,
  uniqueValueName,
  unlinkSetting,
  VALUES_CARD_ID,
} from '../model/notes-values.ts';
import { type FieldDef, fieldsFor } from '../model/schema-fields.ts';
import { effectiveNodeIssues } from '../model/setting-issues.ts';
import { AlreadyProcessedInspector } from './AlreadyProcessedInspector.tsx';
import type { ApplyOptions, GraphOp } from './Canvas.tsx';
import { BooleanField } from './fields/BooleanField.tsx';
import { GroupInspector } from './GroupInspector.tsx';
import { messageUnder } from './IssuesPanel.tsx';
import { NodeForm } from './NodeForm.tsx';
import { RunSubworkflowInspector } from './RunSubworkflowInspector.tsx';
import { ValuesInspector } from './ValuesInspector.tsx';

/** The page's guarded apply: refusals become toasts, read-only drafts never change. */
export type InspectorDispatch = (op: GraphOp, opts?: ApplyOptions) => boolean;

export interface InspectorProps {
  state: EditorState;
  /** Null while the node catalogue is unavailable: every node is then an unknown node. */
  catalog: Catalog | null;
  dispatch: InspectorDispatch;
  readOnly: boolean;
  /** A setting path of the selected node to focus once; `onFocused` clears the request. */
  focusField: string | null;
  onFocused(): void;
  /** `workflows.list` for the Run node's sub-workflow picker (empty while loading). */
  subworkflows?: WorkflowSummary[];
  /**
   * The page's group membership action (`joinGroup` with the card's measured size, so the box
   * grows around the real card); `undefined` leaves the group.
   */
  joinGroup(nodeId: string, groupId: string | undefined): void;
  /** The page's "group the selection" (as the canvas selection toolbar does). */
  groupSelection(name: string): void;
}

const plural = (n: number) => `${n} node${n === 1 ? '' : 's'}`;

/**
 * The inspector column's top part (screen 05): "Select a node" with the workflow's own facts, the group inspector, the
 * selected node's header, settings form, "On the canvas" section and
 * footer, or "N nodes selected" with "Group N nodes" and "Delete N nodes".
 */
export function Inspector(props: InspectorProps) {
  const { state, dispatch, readOnly } = props;
  const { selection, draft } = state;
  const [only] = selection.nodes;
  const node = selection.nodes.length === 1 ? draft.nodes.find((n) => n.id === only) : undefined;

  if (node) return <NodeInspector key={node.id} {...props} node={node} />;
  if (selection.nodes.length > 1) {
    const ids = selection.nodes;
    return (
      <section className="inspector" aria-label="Selection">
        <div className="inspector-body">
          <p className="inspector-multi">{plural(ids.length)} selected</p>
        </div>
        <div className="inspector-footer">
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={readOnly}
            onClick={() => props.groupSelection(DEFAULT_GROUP_NAME)}
          >
            Group {plural(ids.length)}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger-outline"
            disabled={readOnly}
            onClick={() => dispatch((g) => removeNodes(g, ids))}
          >
            Delete {plural(ids.length)}
          </button>
        </div>
      </section>
    );
  }
  if (selection.group === VALUES_CARD_ID && draft.values) {
    return (
      <ValuesInspector
        values={draft.values}
        usedBy={(name) => linkedNodes(draft, name).length}
        readOnly={readOnly}
        onRename={(from, to) => dispatch((g) => renameValue(g, from, to))}
        onValue={(name, value) =>
          dispatch((g) => setValue(g, name, value), {
            coalesce: 'settings',
            key: `value:${name}`,
          })
        }
        onRemove={(name) => dispatch((g) => removeValue(g, name))}
        onDeleteCard={() => dispatch(removeValuesCard)}
      />
    );
  }
  const group = draft.groups.find((g) => g.id === selection.group);
  if (group) {
    const groupId = group.id;
    return (
      <GroupInspector
        key={groupId}
        group={group}
        count={draft.nodes.filter((n) => n.groupId === groupId).length}
        readOnly={readOnly}
        onRename={(name) =>
          dispatch((g) => renameGroup(g, groupId, name), {
            coalesce: 'settings',
            key: `group:${groupId}`,
          })
        }
        onCollapse={(c) => dispatch((g) => setGroupCollapsed(g, groupId, c))}
        onUngroup={() => dispatch((g) => ungroup(g, groupId))}
        onNote={(note) =>
          dispatch((g) => setGroupNote(g, groupId, note), {
            coalesce: 'settings',
            key: `note:${groupId}`,
          })
        }
        focusName={props.focusField === 'name'}
        onFocused={props.onFocused}
      />
    );
  }
  return (
    <section className="inspector" aria-label="Selection">
      <div className="inspector-body">
        <p className="inspector-empty">Select a node</p>
        <dl className="inspector-facts">
          <div>
            <dt>Type</dt>
            <dd>{state.workflow.kind === 'subworkflow' ? 'Sub-workflow' : 'Workflow'}</dd>
          </div>
          <div>
            <dt>Saved version</dt>
            <dd>v{state.savedVersion}</dd>
          </div>
          <div>
            <dt>Nodes</dt>
            <dd>{draft.nodes.length}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

/** The node's `INVALID_SETTINGS` by setting path; a path-less one under `''`. */
function settingIssues(nodeState: NodeState): Map<string, Issue[]> {
  const map = new Map(nodeState.fieldIssues);
  const whole = nodeState.issues.filter(
    (i) => i.code === 'INVALID_SETTINGS' && i.settingPath === undefined,
  );
  if (whole.length > 0) map.set('', whole);
  return map;
}

const UNAVAILABLE_CODES: ReadonlySet<string> = new Set(['NODE_UNAVAILABLE', 'ENCODER_UNAVAILABLE']);

/** "needs a setting" → "Needs a setting"; an unavailable node says why. */
function stateText(nodeState: NodeState, def: NodeInfo | null): string {
  const word = nodeState.word ?? '';
  if (nodeState.badge === 'plugin-stopped') {
    const message = nodeState.issues.find((i) => i.code === 'PLUGIN_UNAVAILABLE')?.message;
    const reason = message?.replace(/^.*can't run: /, '');
    if (reason) return `Plugin not running: ${reason}`;
  }
  if (nodeState.badge === 'unavailable') {
    const reason =
      def?.availability.available === false
        ? def.availability.reason
        : nodeState.issues.find((i) => UNAVAILABLE_CODES.has(i.code))?.message;
    if (reason) return `Not on this server: ${reason}`;
  }
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** What the Run sub-workflow inspector already shows inline (pin line, overrides, missing). */
const RUN_INLINE_CODES: ReadonlySet<string> = new Set([
  'SUBWORKFLOW_OUTDATED',
  'SUBWORKFLOW_MISSING',
  'INVALID_OVERRIDE',
  'OVERRIDE_DROPPED',
]);

/**
 * Node issues the header lists: not the settings ones (the form shows them), not the outdated
 * note, and for a Run node shown by its own inspector (`runInline`) not what that shows inline.
 */
export function headerIssues(nodeState: NodeState, runInline: boolean): Issue[] {
  return nodeState.issues.filter((i) => {
    const { code } = i;
    if (code === 'INVALID_SETTINGS' || code === 'NODE_OUTDATED') return false;
    if (runInline && RUN_INLINE_CODES.has(code)) return false;
    // The state line already says why an unavailable node is unavailable.
    return !(nodeState.badge === 'unavailable' && UNAVAILABLE_CODES.has(code));
  });
}

/** Run node settings that are not an object keep the raw JSON fallback (Review Focus 1). */
const isSettingsObject = (v: JsonValue) => v !== null && typeof v === 'object' && !Array.isArray(v);

const SECTION_KEY = 'tc.inspector.on-the-canvas';

function readOpen(): boolean {
  try {
    return localStorage.getItem(SECTION_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(SECTION_KEY, open ? 'open' : 'closed');
  } catch {
    // Storage unavailable (private mode, quota): the section just opens next time.
  }
}

const BYPASS_FIELD: FieldDef = {
  key: 'bypassed',
  label: 'Bypass',
  hint: 'The file passes through unchanged',
  unit: null,
  // Never "not set": a node is either bypassed or not.
  required: true,
  default: undefined,
  spec: { kind: 'boolean' },
  schema: null,
};

function NodeInspector({
  state,
  catalog,
  dispatch,
  readOnly,
  focusField,
  onFocused,
  subworkflows,
  joinGroup,
  node,
}: InspectorProps & { node: NodeInstance }) {
  const def = catalog?.byType.get(node.type) ?? null;
  const runInline =
    def !== null && node.type === RUN_SUBWORKFLOW_TYPE && isSettingsObject(node.settings);
  // Already processed picks a workflow by name: its own inspector, like the Run node's.
  const processedInline =
    def !== null && node.type === ALREADY_PROCESSED_TYPE && isSettingsObject(node.settings);
  const fields = useMemo(
    () => (def && !runInline ? fieldsFor(def.settingsSchema) : null),
    [def, runInline],
  );
  const validated = state.issuesGraph.nodes.find((n) => n.id === node.id)?.settings;
  // Client check first, the server's message only for the value it validated (Task 13 review).
  const nodeState = useMemo(
    () =>
      nodeStateFor(
        node.id,
        effectiveNodeIssues(node.id, fields, node.settings, validated, state.issues),
        stateTypeFor(node.type, catalog),
      ),
    [node.id, fields, node.settings, validated, state.issues, node.type, catalog],
  );
  const issues = useMemo(() => settingIssues(nodeState), [nodeState]);
  const [open, setOpen] = useState(readOpen);
  const labelId = useId();
  const groupId = useId();

  // NodeForm (a child, so its effect ran first) has focused the field.
  useEffect(() => {
    if (focusField !== null) onFocused();
  }, [focusField, onFocused]);

  const id = node.id;
  const title = def?.title ?? node.type;
  const word = def ? KIND_WORD[def.kind] : 'Unknown';
  const outdated = nodeState.issues.filter((i) => i.code === 'NODE_OUTDATED');
  const listed = headerIssues(nodeState, runInline);
  const glyph = nodeState.badge === null ? 'alert' : BADGE_ICON[nodeState.badge];

  const edit = (op: GraphOp, opts?: ApplyOptions) => {
    if (!readOnly) dispatch(op, opts);
  };

  return (
    <section className="inspector" aria-labelledby={`${labelId}-title`}>
      <header className="inspector-head">
        <div className={`inspector-eyebrow ${kindClassOf(def)}`}>
          <span className="inspector-kind-dot" aria-hidden="true" />
          <KindEyebrow word={word} {...(def ? { source: def.source } : {})} />
        </div>
        <h2 id={`${labelId}-title`} className="inspector-title">
          {title}
        </h2>
        {def?.description && <p className="inspector-description">{def.description}</p>}
        {nodeState.word !== null && (
          <p role="status" className={`inspector-state tone-${nodeState.border ?? 'red'}`}>
            {glyph === '!' || glyph === null ? (
              <Icon name="alert" size={14} round />
            ) : (
              <Icon name={glyph} size={14} round />
            )}
            <span>{stateText(nodeState, def)}</span>
          </p>
        )}
        {listed.length > 0 && (
          <ul className="inspector-issues">
            {listed.map((issue, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: issues have no id; order is stable.
              <li key={i}>{messageUnder(issue, state.draft, catalog)}</li>
            ))}
          </ul>
        )}
        {outdated.map((issue, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: issues have no id; order is stable.
          <p key={i} className="inspector-note">
            <Icon name="info" size={14} round />
            <span>{issue.message} — updated on the next server start</span>
          </p>
        ))}
      </header>

      <div className="inspector-body">
        {runInline ? (
          <RunSubworkflowInspector
            instance={node}
            state={nodeState}
            // A sub-workflow never runs itself.
            subworkflows={(subworkflows ?? []).filter((w) => w.id !== state.workflow.id)}
            readOnly={readOnly}
            dispatch={dispatch}
            focusField={focusField}
          />
        ) : processedInline ? (
          <AlreadyProcessedInspector
            instance={node}
            state={nodeState}
            workflows={subworkflows ?? []}
            selfId={state.workflow.id}
            readOnly={readOnly}
            dispatch={dispatch}
            focusField={focusField}
          />
        ) : (
          <NodeForm
            def={def}
            instance={node}
            issues={issues}
            readOnly={readOnly}
            focusField={focusField}
            onChange={(settings: JsonValue, key?: string) =>
              edit((g) => setSettings(g, id, settings), {
                coalesce: 'settings',
                key: key === undefined ? id : `${id}:${key}`,
              })
            }
            sharing={{
              values: state.draft.values?.entries ?? [],
              usedBy: (name) => linkedNodes(state.draft, name).length,
              onFollow: (key, name) => edit((g) => linkSetting(g, id, key, name)),
              onUnlink: (key) => edit((g) => unlinkSetting(g, id, key)),
              onShare: (key, label, schema) =>
                edit((g) => shareSetting(g, id, key, uniqueValueName(g, label), schema)),
              onValue: (name, value) =>
                edit((g) => setValue(g, name, value), {
                  coalesce: 'settings',
                  key: `value:${name}`,
                }),
            }}
          />
        )}

        <Disclosure
          title="On the canvas"
          className="inspector-section"
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            writeOpen(next);
          }}
        >
          <div className="inspector-section-body">
            <div className="tc-field">
              <div className="tc-field-head">
                <label htmlFor={`${labelId}-name`} className="tc-field-label">
                  Name on the canvas
                </label>
                <span id={`${labelId}-optional`} className="tc-field-notset">
                  optional
                </span>
              </div>
              <input
                id={`${labelId}-name`}
                className="input tc-input"
                value={node.label ?? ''}
                placeholder={title}
                aria-describedby={`${labelId}-optional`}
                maxLength={MAX_LABEL_LENGTH}
                readOnly={readOnly}
                onChange={(e) => {
                  const label = e.target.value;
                  // "settings:label:<id>": typing one name is one undo step.
                  edit((g) => setLabel(g, id, label), { coalesce: 'settings', key: `label:${id}` });
                }}
              />
            </div>
            <BooleanField
              def={BYPASS_FIELD}
              value={node.bypassed === true}
              issue={null}
              readOnly={readOnly}
              onChange={(v) => {
                if ((v === true) !== (node.bypassed === true)) edit((g) => toggleBypass(g, id));
              }}
            />
            <div className="tc-field">
              <div className="tc-field-head">
                <label htmlFor={groupId} className="tc-field-label">
                  Group
                </label>
              </div>
              <select
                id={groupId}
                className="input tc-input"
                value={node.groupId ?? ''}
                disabled={readOnly}
                onChange={(e) => {
                  const target = e.target.value === '' ? undefined : e.target.value;
                  if (!readOnly) joinGroup(id, target);
                }}
              >
                <option value="">None</option>
                {state.draft.groups.map((gr) => (
                  <option key={gr.id} value={gr.id}>
                    {gr.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Disclosure>
      </div>

      <footer className="inspector-footer">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={readOnly || catalog === null}
          onClick={() => {
            if (catalog) edit((g) => duplicateNode(g, id, catalog));
          }}
        >
          Duplicate
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger-outline"
          disabled={readOnly}
          onClick={() => edit((g) => removeNodes(g, [id]))}
        >
          Remove node
        </button>
      </footer>
    </section>
  );
}
