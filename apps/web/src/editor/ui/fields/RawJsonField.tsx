import type { JsonValue } from '@transcoda/shared';
import { useId, useState } from 'react';
import { Icon } from '../../../components/Icon.tsx';
import { Field, type FieldProps } from './Field.tsx';

const format = (v: JsonValue | undefined) => (v === undefined ? '' : JSON.stringify(v, null, 2));

/**
 * The fallback for any schema shape the form has no control for (anti-goal 6): the value as JSON
 * in a textarea. Text that does not parse shows "Not valid JSON" and is not sent; the server's
 * issue shows in the frame's message slot. Empty text means "not set".
 */
export function RawJsonField(props: FieldProps) {
  const { def, value, onChange, readOnly, autoFocus } = props;
  const parseId = useId();
  const [draft, setDraft] = useState(() => format(value));
  const [seen, setSeen] = useState<JsonValue | undefined>(value);
  const [broken, setBroken] = useState(false);
  if (value !== seen) {
    // Changed from outside (undo, another control): show it. Our own edits are recorded in
    // `seen` before they come back, so typing is never reformatted.
    setSeen(value);
    setDraft(format(value));
    setBroken(false);
  }

  function change(text: string) {
    setDraft(text);
    if (text.trim() === '') {
      setBroken(false);
      setSeen(undefined);
      onChange(undefined);
      return;
    }
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(text) as JsonValue;
    } catch {
      setBroken(true);
      return;
    }
    setBroken(false);
    setSeen(parsed);
    onChange(parsed);
  }

  const unit = def.unit ? `${def.unit}, raw JSON` : 'raw JSON';
  return (
    <Field {...props} def={{ ...def, unit }}>
      {(ids) => (
        <>
          <textarea
            id={ids.id}
            className="input tc-input tc-raw"
            rows={Math.min(12, Math.max(3, draft.split('\n').length))}
            value={draft}
            spellCheck={false}
            readOnly={readOnly}
            aria-describedby={
              [broken ? parseId : undefined, ids.describedBy].filter(Boolean).join(' ') || undefined
            }
            aria-invalid={broken || ids.invalid || undefined}
            // biome-ignore lint/a11y/noAutofocus: the inspector focuses a field on request only
            autoFocus={autoFocus}
            onChange={(e) => change(e.target.value)}
          />
          {broken && (
            <p id={parseId} className="tc-field-issue">
              <Icon name="alert" size={14} round />
              Not valid JSON
            </p>
          )}
        </>
      )}
    </Field>
  );
}
