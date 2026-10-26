import { type KeyboardEvent, useState } from 'react';
import { Field, type FieldProps } from './Field.tsx';

/** Free-text chips: Enter in the input adds a trimmed, new entry; × removes one. */
export function StringListField(props: FieldProps) {
  const { def, value, onChange, readOnly, autoFocus } = props;
  const [draft, setDraft] = useState('');
  const list = Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const entry = draft.trim();
    if (entry === '' || list.includes(entry)) return;
    onChange([...list, entry]);
    setDraft('');
  }

  return (
    <Field {...props} labelling="group">
      {(ids) => (
        <fieldset
          className="tc-chips"
          aria-labelledby={ids.labelId}
          aria-describedby={ids.describedBy}
        >
          {list.map((entry) => (
            <span key={entry} className="lang-chip">
              <span>{entry}</span>
              {!readOnly && (
                <button
                  type="button"
                  className="tc-chip-remove"
                  aria-label={`Remove ${entry}`}
                  onClick={() => onChange(list.filter((x) => x !== entry))}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {!readOnly && (
            <input
              className="tc-chips-input"
              aria-label={`Add to ${def.label}`}
              placeholder="Add…"
              value={draft}
              spellCheck={false}
              // biome-ignore lint/a11y/noAutofocus: the inspector focuses a field on request only
              autoFocus={autoFocus}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
            />
          )}
        </fieldset>
      )}
    </Field>
  );
}
