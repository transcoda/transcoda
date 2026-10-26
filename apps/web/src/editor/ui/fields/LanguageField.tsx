import { useId, useState } from 'react';
import { languageName } from '../../../data/languages.ts';
import { LanguagePicker } from '../LanguagePicker.tsx';
import { Field, type FieldProps } from './Field.tsx';

/**
 * One language, chosen in the LanguagePicker. An unset value reads "Any language": that is what
 * an unset language means to the core nodes (core:has-stream matches any language and, in M1,
 * ignores its data input). `originalOption` is accepted but offers nothing yet: no settings value
 * means "the original language from data", and unset must not be aliased to it.
 */
export function LanguageField(props: FieldProps) {
  const { value, onChange, readOnly, autoFocus } = props;
  const [open, setOpen] = useState(false);
  const valueId = useId();
  const code = typeof value === 'string' ? value : undefined;
  const name = code === undefined ? undefined : languageName(code);

  function pick(picked: string) {
    setOpen(false);
    onChange(picked);
  }

  return (
    <Field {...props} notSet={null}>
      {(ids) => (
        <>
          <button
            id={ids.id}
            type="button"
            className="input tc-input tc-language-button"
            aria-labelledby={`${ids.labelId} ${valueId}`}
            aria-describedby={ids.describedBy}
            aria-invalid={ids.invalid || undefined}
            aria-haspopup="dialog"
            disabled={readOnly}
            // biome-ignore lint/a11y/noAutofocus: the inspector focuses a field on request only
            autoFocus={autoFocus}
            onClick={() => setOpen(true)}
          >
            <span id={valueId}>
              {code === undefined ? (
                'Any language'
              ) : (
                <>
                  {name}
                  {name !== code && code !== 'unknown' && (
                    <>
                      {' '}
                      <span className="lang-code">{code}</span>
                    </>
                  )}
                </>
              )}
            </span>
          </button>
          <LanguagePicker
            open={open}
            exclude={code === undefined ? [] : [code]}
            onPick={pick}
            onClose={() => setOpen(false)}
          />
        </>
      )}
    </Field>
  );
}
