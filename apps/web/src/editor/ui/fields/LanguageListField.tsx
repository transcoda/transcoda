import { useState } from 'react';
import { languageName } from '../../../data/languages.ts';
import { LanguagePicker } from '../LanguagePicker.tsx';
import { Field, type FieldProps } from './Field.tsx';

/** Language chips in order ("English en ×", screen 05) and "Add language" opening the picker. */
export function LanguageListField(props: FieldProps) {
  const { value, onChange, readOnly, autoFocus } = props;
  const [open, setOpen] = useState(false);
  const list = Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];

  function add(code: string) {
    setOpen(false);
    if (!list.includes(code)) onChange([...list, code]);
  }

  return (
    <Field {...props} labelling="group">
      {(ids) => (
        <>
          <fieldset
            className="tc-chips"
            aria-labelledby={ids.labelId}
            aria-describedby={ids.describedBy}
          >
            {list.map((code) => {
              const name = languageName(code);
              return (
                <span
                  key={code}
                  className={code === 'unknown' ? 'lang-chip is-untagged' : 'lang-chip'}
                >
                  <span>{name}</span>
                  {name !== code && code !== 'unknown' && <span className="lang-code">{code}</span>}
                  {!readOnly && (
                    <button
                      type="button"
                      className="tc-chip-remove"
                      aria-label={`Remove ${name}`}
                      onClick={() => onChange(list.filter((c) => c !== code))}
                    >
                      ×
                    </button>
                  )}
                </span>
              );
            })}
            {!readOnly && (
              <button
                type="button"
                className="tc-chip-add"
                aria-haspopup="dialog"
                // biome-ignore lint/a11y/noAutofocus: the inspector focuses a field on request only
                autoFocus={autoFocus}
                onClick={() => setOpen(true)}
              >
                Add language
              </button>
            )}
            {list.length === 0 && readOnly && <span className="faint">None</span>}
          </fieldset>
          <LanguagePicker
            open={open}
            title="Add language"
            exclude={list}
            onPick={add}
            onClose={() => setOpen(false)}
          />
        </>
      )}
    </Field>
  );
}
