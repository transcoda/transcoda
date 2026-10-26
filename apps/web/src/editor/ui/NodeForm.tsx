import type { NodeInfo } from '@transcoda/contract';
import type { Issue, JsonValue, NodeInstance, SharedValue } from '@transcoda/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Disclosure } from '../../components/Disclosure.tsx';
import { Icon } from '../../components/Icon.tsx';
import {
  clientIssue,
  differsFromDefault,
  type FieldDef,
  fieldShown,
  fieldsFor,
  isAdvancedSetting,
  isLibraryField,
} from '../model/schema-fields.ts';
import { FieldExtrasContext } from './fields/Field.tsx';
import { LibraryField } from './fields/LibraryField.tsx';
import { RawJsonField } from './fields/RawJsonField.tsx';
import { SettingField } from './fields/SettingField.tsx';
import { SettingLink, shareable } from './SettingLink.tsx';

type JsonObject = { [key: string]: JsonValue };

function isObject(v: JsonValue): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The whole settings value as one raw field (unknown node, or settings that are not an object). */
const WHOLE: FieldDef = {
  key: '',
  label: 'Settings',
  unit: null,
  required: true,
  default: undefined,
  spec: { kind: 'raw' },
  schema: null,
};

/** "languages.1" → "languages": the server reports nested paths; the form has top-level fields. */
const topLevel = (path: string) => path.split('.')[0] ?? path;

const FOCUSABLE = 'input, select, textarea, button, [tabindex]:not([tabindex="-1"])';

/** Focuses the first control of the field for `path` (or of the only field), if there is one. */
function focusField(root: HTMLElement, path: string): void {
  const fields = [...root.querySelectorAll<HTMLElement>('[data-field]')];
  const field =
    fields.find((f) => f.dataset.field === path) ??
    fields.find((f) => f.dataset.field === topLevel(path)) ??
    fields.find((f) => f.dataset.field === '');
  if (!field) return;
  // The control the label names, else the first control that is not the frame's Clear button.
  const labelFor = field.querySelector('label[for]')?.getAttribute('for');
  const named = labelFor ? document.getElementById(labelFor) : null;
  const usable = (el: HTMLElement) => !(el as HTMLButtonElement).disabled;
  const control =
    named && usable(named)
      ? named
      : [...field.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
          (el) => usable(el) && !el.classList.contains('tc-field-clear'),
        );
  control?.focus();
}

/** The workflow's shared values and what the form does with them (absent: no link controls). */
export interface Sharing {
  values: readonly SharedValue[];
  /** How many nodes follow the value. */
  usedBy(name: string): number;
  onFollow(key: string, name: string): void;
  onUnlink(key: string): void;
  /** A new value from the setting; `label` names it. */
  onShare(key: string, label: string, schema: JsonValue): void;
  /** A linked field was edited: the value changes for every setting that follows it. */
  onValue(name: string, value: JsonValue): void;
}

/**
 * The node's settings form, generated from its JSON Schema (Task 12 field controls). Settings that
 * are not an object, or a node type the catalogue does not know, get one raw JSON field over the
 * whole value with the server's message (anti-goal 6, Review Focus 1). `issues` are the node's
 * `INVALID_SETTINGS` by `settingPath` (`''` for a path-less one); a field shows the client's check
 * (`clientIssue`: required, bounds, enum) first, else the server's first message (the inspector
 * passes only messages for the value the server validated). `onChange` gets the merged settings
 * and the key. Rarely changed settings (`isAdvancedSetting`) follow under a closed "Advanced",
 * which opens for a message inside it or a field asked to be focused.
 */
export function NodeForm({
  def,
  instance,
  issues,
  readOnly,
  onChange,
  focusField: focusPath,
  sharing,
}: {
  def: NodeInfo | null;
  instance: NodeInstance;
  issues: Map<string, Issue[]>;
  readOnly: boolean;
  onChange(settings: JsonValue, key?: string): void;
  /** A setting path to focus (once per change of this value). */
  focusField: string | null;
  sharing?: Sharing;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fields = useMemo(() => (def ? fieldsFor(def.settingsSchema) : []), [def]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** Whether Advanced had to open on the last render (it opens again on the next change to true). */
  const [wasMustOpen, setWasMustOpen] = useState(false);

  useEffect(() => {
    if (focusPath !== null && ref.current) focusField(ref.current, focusPath);
  }, [focusPath]);

  const links = instance.links;
  /** The value a field follows, when it still exists. */
  const followed = useCallback(
    (key: string) => {
      const name = links?.[key];
      return name === undefined ? undefined : sharing?.values.find((v) => v.name === name);
    },
    [links, sharing],
  );
  const extras = useCallback(
    (key: string) => {
      const field = fields.find((f) => f.key === key);
      if (!sharing || readOnly || !field || !shareable(field)) return null;
      const value = followed(key);
      const others = value ? sharing.usedBy(value.name) - 1 : 0;
      return {
        head: (
          <SettingLink
            field={field}
            linked={value?.name ?? null}
            values={sharing.values}
            onFollow={(name) => sharing.onFollow(key, name)}
            onUnlink={() => sharing.onUnlink(key)}
            onShare={() => sharing.onShare(key, field.label, field.schema)}
          />
        ),
        foot:
          others > 0 ? (
            <span className="tc-field-hint">
              Also used by {others} other {others === 1 ? 'node' : 'nodes'}
            </span>
          ) : null,
      };
    },
    [fields, sharing, readOnly, followed],
  );

  const settings = instance.settings;
  if (!def || !isObject(settings)) {
    const first = issues.get('')?.[0] ?? [...issues.values()].flat()[0];
    return (
      <div ref={ref} className="node-form">
        <RawJsonField
          def={WHOLE}
          value={settings}
          issue={first?.message ?? null}
          readOnly={readOnly}
          // Emptied text means no settings at all.
          onChange={(v) => onChange(v ?? {}, '')}
        />
      </div>
    );
  }

  const keys = new Set(fields.map((f) => f.key));
  const issueFor = (key: string): string | null => {
    const exact = issues.get(key)?.[0];
    if (exact) return exact.message;
    for (const [path, list] of issues) {
      if (path !== key && topLevel(path) === key && list[0]) return list[0].message;
    }
    return null;
  };
  // Server messages no field shows (a path-less one, or a key the schema does not have).
  const unplaced = [...issues]
    .filter(([path]) => !keys.has(topLevel(path)))
    .flatMap(([, list]) => list);
  const hasLanguageInput = def.inputs.some((p) => p.type === 'data:language');

  function change(key: string, v: JsonValue | undefined) {
    const next: JsonObject = { ...(settings as JsonObject) };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next, key);
  }

  // Each field shown, with its message; a field for another mode is hidden unless it has one.
  const shown = fields.flatMap((field) => {
    const shared = followed(field.key);
    const value = shared ? shared.value : settings[field.key];
    const issue = clientIssue(field, value) ?? issueFor(field.key);
    if (issue === null && !fieldShown(field, settings, fields)) return [];
    return [{ field, value, issue, shared, advanced: isAdvancedSetting(def.type, field.key) }];
  });
  const advanced = shown.filter((f) => f.advanced);
  const changed = advanced.filter((f) => differsFromDefault(f.field, f.value)).length;
  // Advanced opens for a message inside it, or for a field the inspector is asked to focus there
  // (set while rendering, so the focus effect below finds the field).
  const mustOpen =
    advanced.some((f) => f.issue !== null) ||
    (focusPath !== null && advanced.some((f) => f.field.key === topLevel(focusPath)));
  if (mustOpen && !wasMustOpen) {
    setWasMustOpen(true);
    setAdvancedOpen(true);
  } else if (!mustOpen && wasMustOpen) setWasMustOpen(false);

  const control = ({ field, value, issue, shared }: (typeof shown)[number]) => {
    const Control = isLibraryField(def, field) ? LibraryField : SettingField;
    return (
      <Control
        key={field.key}
        def={field}
        value={value}
        issue={issue}
        readOnly={readOnly}
        onChange={(v) => {
          if (!shared || !sharing) change(field.key, v);
          else if (v !== undefined) sharing.onValue(shared.name, v);
          else {
            // Clearing a linked setting clears this node's copy, not the value.
            sharing.onUnlink(field.key);
            change(field.key, undefined);
          }
        }}
        originalOption={hasLanguageInput}
      />
    );
  };

  return (
    <FieldExtrasContext.Provider value={extras}>
      <div ref={ref} className="node-form">
        {unplaced.map((issue, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: issues have no id; order is stable.
          <p key={i} className="tc-field-issue">
            <Icon name="alert" size={14} round />
            {issue.message}
          </p>
        ))}
        {shown.filter((f) => !f.advanced).map(control)}
        {advanced.length > 0 ? (
          <Disclosure
            title="Advanced"
            className="inspector-advanced"
            meta={changed > 0 ? `${changed} changed` : null}
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
          >
            {advanced.map(control)}
          </Disclosure>
        ) : null}
      </div>
    </FieldExtrasContext.Provider>
  );
}
