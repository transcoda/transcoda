import type { SubworkflowSetting } from '@transcoda/contract';
import type { JsonValue } from '@transcoda/shared';
import { useId, useState } from 'react';
import { clientIssue, type FieldDef, fieldsFor, isRedactedUrl } from '../model/schema-fields.ts';
import { SettingField } from './fields/SettingField.tsx';

/** The child's value as read-only text: "en, de" / "yes" / "24"; "not set" when it has none. */
export function defaultText(value: JsonValue): string {
  if (value === null) return 'not set';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) {
    return value.length === 0 ? 'none' : value.map((v) => defaultText(v)).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** The inspector field for one entry: label, unit and hint as the node's own form shows them. */
function fieldOf(entry: SubworkflowSetting): FieldDef {
  const [field] = fieldsFor({
    type: 'object',
    properties: { [entry.settingKey]: entry.schema },
    // The Override switch says whether there is a value; the control never offers "Clear".
    required: [entry.settingKey],
  });
  return { ...(field as FieldDef), key: entry.key };
}

function OverrideRow({
  entry,
  value,
  on,
  issue,
  readOnly,
  onToggle,
  onChange,
}: {
  entry: SubworkflowSetting;
  value: JsonValue | undefined;
  on: boolean;
  issue: string | null;
  readOnly: boolean;
  onToggle(on: boolean): void;
  onChange(v: JsonValue | undefined): void;
}) {
  const def = fieldOf(entry);
  const labelId = useId();
  return (
    <div className="override-row">
      <div className="override-row-head">
        <span id={labelId} className="tc-field-label">
          {def.label}
        </span>
        <button
          type="button"
          role="switch"
          className="override-toggle"
          aria-checked={on}
          aria-label={`Override ${def.label}`}
          disabled={readOnly}
          onClick={() => onToggle(!on)}
        >
          <span className="tc-switch" aria-hidden="true">
            <span className="tc-switch-knob" />
          </span>
          <span aria-hidden="true">Override</span>
        </button>
      </div>
      <p className="override-default">
        <span className="override-default-word">Default</span>{' '}
        <span>{defaultText(entry.default)}</span>
      </p>
      {on && (
        <SettingField
          def={def}
          value={value}
          issue={clientIssue(def, value) ?? issue}
          readOnly={readOnly}
          onChange={onChange}
          labelHidden
        />
      )}
    </div>
  );
}

/**
 * The Run node's overrides (design: "overrides editor from the child's settings schema"): one
 * section per child node (h3, its title), one row per setting with the child's value read-only
 * and an "Override" switch that reveals the field control generated from the entry's schema.
 * Keys `<nodeId>.<settingKey>`. Overrides whose key the child no longer has are listed as
 * "will be dropped on save: <key>" (the server's OVERRIDE_DROPPED) with "Remove now".
 * `issues` are the server's INVALID_OVERRIDE messages by override key.
 */
export function OverridesEditor({
  settings,
  overrides,
  issues,
  readOnly,
  onSet,
}: {
  settings: SubworkflowSetting[];
  overrides: Record<string, JsonValue>;
  issues?: ReadonlyMap<string, string>;
  readOnly: boolean;
  onSet(key: string, value: JsonValue | undefined): void;
}) {
  // Switched on but emptied (a control reports "no value"): the row stays open until switched off.
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  const headId = useId();

  const known = new Set(settings.map((s) => s.key));
  const stale = Object.keys(overrides).filter((key) => !known.has(key));
  const sections: Array<{ nodeId: string; title: string; entries: SubworkflowSetting[] }> = [];
  for (const entry of settings) {
    const section = sections.find((s) => s.nodeId === entry.nodeId);
    if (section) section.entries.push(entry);
    else sections.push({ nodeId: entry.nodeId, title: entry.nodeTitle, entries: [entry] });
  }

  const hold = (key: string, keep: boolean) =>
    setHeld((prev) => {
      if (prev.has(key) === keep) return prev;
      const next = new Set(prev);
      if (keep) next.add(key);
      else next.delete(key);
      return next;
    });

  if (settings.length === 0 && stale.length === 0) {
    return <p className="overrides-empty">This sub-workflow has no settings to override</p>;
  }

  return (
    <div className="overrides">
      {stale.map((key) => (
        <p key={key} className="override-stale">
          <span>will be dropped on save: {key}</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={readOnly}
            onClick={() => onSet(key, undefined)}
          >
            Remove now
          </button>
        </p>
      ))}
      {sections.map((section, i) => (
        <section key={section.nodeId} className="overrides-node" aria-labelledby={`${headId}-${i}`}>
          <h3 id={`${headId}-${i}`} className="overrides-node-title">
            {section.title}
          </h3>
          {section.entries.map((entry) => {
            const value = Object.hasOwn(overrides, entry.key) ? overrides[entry.key] : undefined;
            return (
              <OverrideRow
                key={entry.key}
                entry={entry}
                value={value}
                on={value !== undefined || held.has(entry.key)}
                issue={issues?.get(entry.key) ?? null}
                readOnly={readOnly}
                onToggle={(next) => {
                  hold(entry.key, next);
                  // Starts from the child's value; a child without one starts empty, and so
                  // does a redacted webhook URL (saved here it would be stored as typed).
                  if (next && entry.default !== null && !isRedactedUrl(entry.default)) {
                    onSet(entry.key, structuredClone(entry.default));
                  } else if (!next) onSet(entry.key, undefined);
                }}
                onChange={(v) => {
                  hold(entry.key, true);
                  onSet(entry.key, v);
                }}
              />
            );
          })}
        </section>
      ))}
    </div>
  );
}
