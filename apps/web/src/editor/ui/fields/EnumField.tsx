import type { KeyboardEvent } from 'react';
import { Field, type FieldProps, humanise } from './Field.tsx';

const NEXT: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * An enum: a segmented radio group (≤ 5 options; arrow keys move the choice, one tab stop) or a
 * `<select>`. An unset value selects nothing; the select then shows an empty first entry.
 */
export function EnumField(props: FieldProps) {
  const { def, value, onChange, readOnly, autoFocus } = props;
  if (def.spec.kind !== 'enum') return null;
  const { options, control } = def.spec;
  const current = typeof value === 'string' && options.includes(value) ? value : undefined;

  if (control === 'select') {
    return (
      <Field {...props}>
        {(ids) => (
          <select
            id={ids.id}
            className="input tc-input"
            value={current ?? ''}
            disabled={readOnly}
            aria-describedby={ids.describedBy}
            aria-invalid={ids.invalid || undefined}
            // biome-ignore lint/a11y/noAutofocus: the inspector focuses a field on request only
            autoFocus={autoFocus}
            onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          >
            {current === undefined && <option value="">—</option>}
            {options.map((o) => (
              <option key={o} value={o}>
                {humanise(o)}
              </option>
            ))}
          </select>
        )}
      </Field>
    );
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = NEXT[e.key];
    if (step === undefined || readOnly) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    const option = options[next];
    if (option === undefined) return;
    onChange(option);
    const group = e.currentTarget.parentElement;
    group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  const tabStop = current ?? options[0];
  return (
    <Field {...props} labelling="group">
      {(ids) => (
        <div
          role="radiogroup"
          className="tc-segmented"
          aria-labelledby={ids.labelId}
          aria-describedby={ids.describedBy}
          aria-invalid={ids.invalid || undefined}
        >
          {options.map((o, i) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented control of buttons with a roving tab stop and arrow keys.
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={o === current}
              tabIndex={o === tabStop ? 0 : -1}
              disabled={readOnly}
              // biome-ignore lint/a11y/noAutofocus: the inspector focuses a field on request only
              autoFocus={autoFocus && o === tabStop}
              onClick={() => onChange(o)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {humanise(o)}
            </button>
          ))}
        </div>
      )}
    </Field>
  );
}
