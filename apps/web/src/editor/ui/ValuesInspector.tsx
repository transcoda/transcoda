import type { SharedValue, SharedValues } from '@transcoda/shared';
import { useId, useMemo, useState } from 'react';
import { fieldsFor } from '../model/schema-fields.ts';
import { SettingField } from './fields/SettingField.tsx';

const usedText = (n: number) =>
  n === 0 ? 'Not used yet' : `Used by ${n} ${n === 1 ? 'node' : 'nodes'}`;

/** One value: its name (renamed when the field is left), its content and how many nodes follow it. */
function ValueRow({
  value,
  uses,
  readOnly,
  onRename,
  onValue,
  onRemove,
}: {
  value: SharedValue;
  uses: number;
  readOnly: boolean;
  onRename(name: string): void;
  onValue(v: SharedValue['value']): void;
  onRemove(): void;
}) {
  const id = useId();
  const [text, setText] = useState(value.name);
  const [seen, setSeen] = useState(value.name);
  if (seen !== value.name) {
    setSeen(value.name);
    setText(value.name);
  }
  // The content is edited with the control of the setting it was made from.
  const field = useMemo(() => {
    const def = fieldsFor({ type: 'object', properties: { value: value.schema } })[0];
    return def ? { ...def, label: 'Value', required: true, hint: usedText(uses) } : null;
  }, [value.schema, uses]);
  const commit = () => {
    if (readOnly) return;
    if (text.trim() === '' || text.trim() === value.name) setText(value.name);
    else onRename(text.trim());
  };

  return (
    <div className="values-row">
      <div className="tc-field">
        <div className="tc-field-head">
          <label htmlFor={`${id}-name`} className="tc-field-label">
            Name
          </label>
          {!readOnly && (
            <button
              type="button"
              className="tc-field-clear"
              aria-label={`Remove ${value.name}`}
              onClick={onRemove}
            >
              Remove
            </button>
          )}
        </div>
        <input
          id={`${id}-name`}
          aria-label={`Name of ${value.name}`}
          className="input tc-input"
          value={text}
          maxLength={60}
          readOnly={readOnly}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
      </div>
      {field && (
        <SettingField
          def={field}
          value={value.value}
          issue={null}
          readOnly={readOnly}
          onChange={(v) => {
            if (v !== undefined) onValue(v);
          }}
        />
      )}
    </div>
  );
}

/**
 * The inspector for the selected values card: every shared value, editable here or from any
 * setting that follows it, and Delete card (the settings keep their current copies).
 */
export function ValuesInspector({
  values,
  usedBy,
  readOnly,
  onRename,
  onValue,
  onRemove,
  onDeleteCard,
}: {
  values: SharedValues;
  usedBy(name: string): number;
  readOnly: boolean;
  onRename(from: string, to: string): void;
  onValue(name: string, value: SharedValue['value']): void;
  onRemove(name: string): void;
  onDeleteCard(): void;
}) {
  const id = useId();
  return (
    <section className="inspector" aria-labelledby={`${id}-title`}>
      <header className="inspector-head">
        <div className="inspector-eyebrow is-caps">Card</div>
        <h2 id={`${id}-title`} className="inspector-title">
          Shared values
        </h2>
        <p className="inspector-description">
          Values several node settings follow: change one here and every setting that follows it
          changes too.
        </p>
      </header>
      <div className="inspector-body">
        {values.entries.length === 0 ? (
          <p className="inspector-description">
            None yet. Use the link button next to a node setting to share it.
          </p>
        ) : (
          values.entries.map((v) => (
            <ValueRow
              key={v.name}
              value={v}
              uses={usedBy(v.name)}
              readOnly={readOnly}
              onRename={(to) => onRename(v.name, to)}
              onValue={(value) => onValue(v.name, value)}
              onRemove={() => onRemove(v.name)}
            />
          ))
        )}
      </div>
      <footer className="inspector-footer">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={readOnly}
          onClick={onDeleteCard}
        >
          Delete card
        </button>
      </footer>
    </section>
  );
}
