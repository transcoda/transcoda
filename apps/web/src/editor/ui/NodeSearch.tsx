import type { NodeInfo, WorkflowSummary } from '@transcoda/contract';
import { RUN_SUBWORKFLOW_TYPE, SUBWORKFLOW_START_TYPE, type WorkflowKind } from '@transcoda/shared';
import { type KeyboardEvent, useEffect, useId, useState } from 'react';
import { KIND_WORD } from '../../components/Chips.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { Icon } from '../../components/Icon.tsx';
import { NodeIcon } from '../../components/NodeIcon.tsx';
import type { Catalog, PortType } from '../../hooks/useCatalog.ts';
import { compatibleTargets, type NextRule } from '../model/connection.ts';
import { matchesQuery, PluginMark, unavailableReason } from './Palette.tsx';

/**
 * A filtered search: the dragged-from port's type, its label for the hint under the list, and
 * (`nextNodeRule`) what may follow that output — after a finish node only later finish steps.
 */
export type SearchFilter = {
  portType: PortType;
  label?: string | undefined;
  rule?: NextRule | undefined;
};

/**
 * The nodes the overlay offers: with a filter, `compatibleTargets` (nodes with an input of that
 * port type); without one, every node the graph kind allows — no start/end in a workflow, no
 * trigger/finish in a sub-workflow, and never a second Start (a sub-workflow always has one).
 */
function candidates(
  catalog: Catalog,
  graphKind: WorkflowKind,
  filter: SearchFilter | null,
): NodeInfo[] {
  if (filter) return compatibleTargets(catalog, filter.portType, graphKind, filter.rule);
  return catalog.nodes.filter((n) => {
    if (graphKind === 'workflow') return n.kind !== 'subworkflow-io';
    return n.kind !== 'trigger' && n.kind !== 'finish' && n.type !== SUBWORKFLOW_START_TYPE;
  });
}

/** A row of the list: a node type, or a named sub-workflow (a Run node set to it). */
type Entry = { def: NodeInfo; workflow: WorkflowSummary | null };

/**
 * The rows: `candidates`, then (when a Run node fits here) the other sub-workflows by name, as the
 * palette's Sub-workflows section offers them.
 */
function entries(
  catalog: Catalog,
  graphKind: WorkflowKind,
  filter: SearchFilter | null,
  subworkflows: WorkflowSummary[],
  selfId: string | null,
): Entry[] {
  const defs = candidates(catalog, graphKind, filter);
  const run = defs.find((d) => d.type === RUN_SUBWORKFLOW_TYPE);
  const named = run
    ? subworkflows
        .filter((w) => w.kind === 'subworkflow' && w.id !== selfId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((workflow) => ({ def: run, workflow }))
    : [];
  return [...defs.map((def) => ({ def, workflow: null })), ...named];
}

function nextEnabled(list: Entry[], disabled: (n: Entry) => boolean, from: number, step: 1 | -1) {
  for (let i = from + step; i >= 0 && i < list.length; i += step) {
    const n = list[i];
    if (n && !disabled(n)) return i;
  }
  return from;
}

/**
 * N4: the line under a filtered list that says which nodes it holds — "a file" for a file output,
 * for a data output the port's label when it has one ("Audio track" → "an audio track input"),
 * otherwise the type id (`data:audio-track` → "an audio-track input"). "a" or "an" by the first
 * letter. A label keeps its case when it starts with an acronym ("HDR format"). After a finish
 * node (#25) it says why only later finish steps are listed.
 */
export function filterHint(
  portType: PortType,
  label?: string | undefined,
  rule?: NextRule | undefined,
): string {
  if (rule?.kind === 'finish-after') {
    if (rule.damaged === true) {
      return 'On the Damaged side, only notifications and other non-writing steps are listed';
    }
    return rule.noWrite
      ? "After the size gate's No, only notifications and other non-writing steps are listed"
      : `After ${rule.afterTitle}, only later finish steps are listed`;
  }
  if (portType === 'file') return 'Only nodes that accept a file are listed';
  const name = label ? lowerFirst(label) : portType.slice('data:'.length);
  const article = /^[aeiou]/i.test(name) ? 'an' : 'a';
  return `Only nodes with ${article} ${name} input are listed`;
}

function lowerFirst(text: string): string {
  return /^[A-Z][A-Z]/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

function matchCount(n: number): string {
  return n === 1 ? '1 match' : `${n} matches`;
}

/** Mounted only while open, so the query and the active row start fresh every time. */
function OpenSearch({
  catalog,
  graphKind,
  filter,
  title,
  subworkflows,
  selfId,
  onPick,
  onClose,
}: {
  catalog: Catalog;
  graphKind: WorkflowKind;
  filter: SearchFilter | null;
  title: string;
  subworkflows: WorkflowSummary[];
  selfId: string | null;
  onPick(def: NodeInfo, workflow?: WorkflowSummary): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const hintId = `${baseId}-hint`;

  const list = entries(catalog, graphKind, filter, subworkflows, selfId).filter((e) =>
    e.workflow
      ? matchesQuery(query, e.workflow.name)
      : matchesQuery(query, e.def.title, e.def.description),
  );
  const isDisabled = (e: Entry) => !e.def.availability.available;
  const first = list.findIndex((n) => !isDisabled(n));
  // `active` may point past a list that just shrank, or at a disabled row: fall back to the first.
  const current = list[active] && !isDisabled(list[active]) ? active : first;
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const activeId = current >= 0 ? optionId(current) : undefined;

  // Keep the active row visible while arrowing through a long list (jsdom has no scrollIntoView).
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Keys that confirm or move an IME composition belong to the composition.
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (current < 0) return;
      setActive(nextEnabled(list, isDisabled, current, e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = list[current];
      if (entry) pick(entry);
    }
  }

  function pick(entry: Entry) {
    if (entry.workflow) onPick(entry.def, entry.workflow);
    else onPick(entry.def);
  }

  const heading = filter ? `${title} · ${matchCount(list.length)}` : title;

  return (
    <Dialog open title={heading} onClose={onClose}>
      <label htmlFor={`${baseId}-q`} className="sr-only">
        Search nodes
      </label>
      <input
        id={`${baseId}-q`}
        className="input node-search-input"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-describedby={filter ? hintId : undefined}
        placeholder="Search nodes"
        autoComplete="off"
        data-autofocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div id={listId} role="listbox" aria-label={heading} className="node-search-list">
        {list.map((entry, i) => {
          const { def, workflow } = entry;
          const reason = unavailableReason(def, graphKind);
          const disabled = isDisabled(entry);
          const plugin = def.source.kind === 'plugin';
          const label = workflow
            ? `${workflow.name}, sub-workflow`
            : plugin
              ? `${def.title}, plugin`
              : def.title;
          return (
            // The input keeps focus and drives the active option (combobox pattern); a click
            // picks too, so the options take no keyboard handlers of their own.
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard goes through the combobox input.
            <div
              key={workflow ? `sub:${workflow.id}` : def.type}
              id={optionId(i)}
              role="option"
              tabIndex={-1}
              aria-label={label}
              aria-selected={i === current}
              aria-disabled={disabled}
              aria-describedby={reason ? `${optionId(i)}-why` : undefined}
              className="node-search-option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (!disabled) pick(entry);
              }}
            >
              {workflow ? (
                <Icon name="subworkflow" size={14} strokeWidth={2.6} round />
              ) : (
                <NodeIcon name={def.icon} kind={def.kind} size={14} />
              )}
              <span className="node-search-title">{workflow ? workflow.name : def.title}</span>
              {plugin && <PluginMark />}
              <span className="node-search-kind">
                {workflow ? KIND_WORD.subworkflow : KIND_WORD[def.kind]}
              </span>
              {reason && (
                <span id={`${optionId(i)}-why`} className="node-search-reason">
                  {reason}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {list.length === 0 && <p className="node-search-empty">No nodes match</p>}
      {filter && (
        <p id={hintId} className="node-search-hint">
          {filterHint(filter.portType, filter.label, filter.rule)}
        </p>
      )}
    </Dialog>
  );
}

/**
 * The ⌘K-style "add a node" overlay. With `filter` (a "+" handle or a dragged connection) it lists
 * only nodes with an input of that port type (after a finish node, only the finish steps that may
 * follow it), its heading counts them (`title` plus " · N matches") and a line under the list
 * (`filterHint`, also the combobox's description) says so. Arrow keys move, Enter picks, Escape closes; unavailable nodes are listed disabled with
 * their reason. The parent closes it after `onPick`.
 */
export function NodeSearch({
  open,
  catalog,
  graphKind,
  filter = null,
  title,
  subworkflows = [],
  selfId = null,
  onPick,
  onClose,
}: {
  open: boolean;
  catalog: Catalog;
  graphKind: WorkflowKind;
  filter?: SearchFilter | null;
  title: string;
  /** Named sub-workflows to offer as Run nodes (the palette's Sub-workflows); `selfId` is left out. */
  subworkflows?: WorkflowSummary[];
  selfId?: string | null;
  /** `workflow`: a named sub-workflow was picked (a Run node set to its current version). */
  onPick(def: NodeInfo, workflow?: WorkflowSummary): void;
  onClose(): void;
}) {
  if (!open) return null;
  return (
    <OpenSearch
      catalog={catalog}
      graphKind={graphKind}
      filter={filter}
      title={title}
      subworkflows={subworkflows}
      selfId={selfId}
      onPick={onPick}
      onClose={onClose}
    />
  );
}
