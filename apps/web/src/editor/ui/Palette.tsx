import type { NodeInfo, WorkflowSummary } from '@transcoda/contract';
import { SUBWORKFLOW_END_TYPE, type WorkflowKind } from '@transcoda/shared';
import { type DragEvent, type ReactNode, type RefObject, useId, useState } from 'react';
import { KIND_WORD } from '../../components/Chips.tsx';
import { Icon } from '../../components/Icon.tsx';
import { NodeIcon } from '../../components/NodeIcon.tsx';
import type { Catalog } from '../../hooks/useCatalog.ts';

export type PaletteItem =
  | { kind: 'node'; def: NodeInfo }
  | { kind: 'subworkflow'; workflow: WorkflowSummary }
  | { kind: 'end' }
  /** An empty frame holding a Markdown note. */
  | { kind: 'note' }
  /** The card of shared values (one per workflow). */
  | { kind: 'values' };

/** The drag payload's MIME type; the canvas reads `JSON.parse(getData(...))` as a `PaletteItem`. */
export const PALETTE_DRAG_TYPE = 'application/x-transcoda-node';

const MAIN_ONLY = 'main workflow only';
const NOTE_TITLE = 'Note';
const VALUES_TITLE = 'Shared values';

/** Case-insensitive substring match on the title and the description. */
export function matchesQuery(query: string, ...texts: string[]): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || texts.some((t) => t.toLowerCase().includes(q));
}

/** The reason a catalogue node can't be added in this graph, or null. */
export function unavailableReason(def: NodeInfo, graphKind: WorkflowKind): string | null {
  if (!def.availability.available) return def.availability.reason;
  if (graphKind === 'subworkflow' && (def.kind === 'trigger' || def.kind === 'finish')) {
    return MAIN_ONLY;
  }
  return null;
}

/** The plug icon after a plugin node's title (screen 05). */
export function PluginMark() {
  return (
    <span className="plugin-mark" role="img" aria-label="plugin">
      <Icon name="plugins" size={13} />
    </span>
  );
}

function PaletteButton({
  item,
  icon,
  title,
  plugin = false,
  reason,
  disabled,
  onAdd,
  onDragStart,
}: {
  item: PaletteItem;
  icon: ReactNode;
  title: string;
  plugin?: boolean;
  reason: string | null;
  disabled: boolean;
  onAdd(item: PaletteItem): void;
  onDragStart(item: PaletteItem, e: DragEvent): void;
}) {
  const reasonId = useId();
  return (
    <button
      type="button"
      className="palette-item"
      aria-label={plugin ? `${title}, plugin` : title}
      aria-disabled={disabled}
      aria-describedby={reason ? reasonId : undefined}
      draggable={!disabled}
      onClick={() => {
        if (!disabled) onAdd(item);
      }}
      onDragStart={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData(PALETTE_DRAG_TYPE, JSON.stringify(item));
        e.dataTransfer.effectAllowed = 'copy';
        onDragStart(item, e);
      }}
    >
      <span className="palette-item-line">
        {icon}
        <span className="palette-item-title">{title}</span>
        {plugin && <PluginMark />}
      </span>
      {reason && (
        <span id={reasonId} className="palette-item-reason" aria-hidden="true">
          {reason}
        </span>
      )}
    </button>
  );
}

function Section({ label, kind, children }: { label: string; kind: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of buttons, not a form fieldset.
    <div role="group" aria-label={label} className="palette-section">
      <div className={`palette-heading palette-heading-${kind}`} aria-hidden="true">
        <span className="palette-swatch" />
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * The editor's left column (screen 05): search, one section per kind in palette order, then
 * "Sub-workflows" (the other sub-workflows and, in a sub-workflow, the End node). Click adds,
 * drag carries a `PaletteItem` as `PALETTE_DRAG_TYPE`. Disabled items stay focusable
 * (`aria-disabled`) so their reason line is reachable.
 */
export function Palette({
  catalog,
  graphKind,
  selfId,
  subworkflows,
  readOnly,
  hasValues,
  onAdd,
  onDragStart,
  searchRef,
}: {
  catalog: Catalog;
  graphKind: WorkflowKind;
  selfId: string;
  subworkflows: WorkflowSummary[];
  readOnly: boolean;
  /** The workflow already has its values card: the item says so instead of adding another. */
  hasValues: boolean;
  onAdd(item: PaletteItem): void;
  onDragStart(item: PaletteItem, e: DragEvent): void;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const [query, setQuery] = useState('');
  const searchId = useId();

  const sections = catalog.kinds
    .map((kind) => ({
      kind,
      defs: catalog.nodes.filter(
        (n) => n.kind === kind && matchesQuery(query, n.title, n.description),
      ),
    }))
    .filter((s) => s.defs.length > 0);

  const endDef = catalog.byType.get(SUBWORKFLOW_END_TYPE);
  const end =
    graphKind === 'subworkflow' && endDef && matchesQuery(query, endDef.title, endDef.description)
      ? endDef
      : null;
  const subs = subworkflows.filter(
    (w) => w.kind === 'subworkflow' && w.id !== selfId && matchesQuery(query, w.name),
  );

  const common = { onAdd, onDragStart };
  const showNote = matchesQuery(query, NOTE_TITLE, 'markdown explanation text');
  const showValues = matchesQuery(query, VALUES_TITLE, 'constant variable shared');
  const empty = sections.length === 0 && !end && subs.length === 0 && !showNote && !showValues;

  return (
    <aside aria-label="Node palette" className="palette">
      <div className="palette-search">
        <label htmlFor={searchId} className="sr-only">
          Search nodes
        </label>
        <input
          id={searchId}
          ref={searchRef}
          type="search"
          className="input palette-search-input"
          placeholder="Search nodes"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span aria-hidden="true">
          <kbd>/</kbd>
        </span>
      </div>

      {sections.map(({ kind, defs }) => (
        <Section key={kind} label={KIND_WORD[kind]} kind={kind}>
          {defs.map((def) => {
            const reason = unavailableReason(def, graphKind);
            return (
              <PaletteButton
                key={def.type}
                item={{ kind: 'node', def }}
                icon={<NodeIcon name={def.icon} kind={def.kind} size={14} />}
                title={def.title}
                plugin={def.source.kind === 'plugin'}
                reason={reason}
                disabled={readOnly || reason !== null}
                {...common}
              />
            );
          })}
        </Section>
      ))}

      {(end || subs.length > 0) && (
        <Section label="Sub-workflows" kind="subworkflow">
          {end && (
            <PaletteButton
              item={{ kind: 'end' }}
              icon={<NodeIcon name={end.icon} kind={end.kind} size={14} />}
              title={end.title}
              reason={null}
              disabled={readOnly}
              {...common}
            />
          )}
          {subs.map((workflow) => (
            <PaletteButton
              key={workflow.id}
              item={{ kind: 'subworkflow', workflow }}
              icon={<Icon name="subworkflow" size={14} strokeWidth={2.6} round />}
              title={workflow.name}
              reason={null}
              disabled={readOnly}
              {...common}
            />
          ))}
        </Section>
      )}

      {(showNote || showValues) && (
        <Section label="Notes & values" kind="canvas">
          {showNote && (
            <PaletteButton
              item={{ kind: 'note' }}
              icon={<Icon name="note" size={14} strokeWidth={2.4} round />}
              title={NOTE_TITLE}
              reason={null}
              disabled={readOnly}
              {...common}
            />
          )}
          {showValues && (
            <PaletteButton
              item={{ kind: 'values' }}
              icon={<Icon name="link" size={14} strokeWidth={2.4} round />}
              title={VALUES_TITLE}
              reason={hasValues ? 'already on the canvas' : null}
              disabled={readOnly || hasValues}
              {...common}
            />
          )}
        </Section>
      )}

      {empty && query.trim() !== '' && (
        <p className="palette-empty">No nodes match “{query.trim()}”</p>
      )}
    </aside>
  );
}
