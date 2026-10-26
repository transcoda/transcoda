import type { JsonValue } from '@transcoda/shared';
import { useState } from 'react';
import { coerce, type FieldSpec, numberStep, snapNumber } from '../../model/schema-fields.ts';
import { Field, type FieldProps, placeholderFor } from './Field.tsx';

/** A stored number as shown: on the field's step (a percent saved as 11.58 reads 12). */
export function numberText(spec: FieldSpec, v: JsonValue | undefined): string {
  if (typeof v !== 'number') return '';
  return String(spec.kind === 'number' && !spec.integer ? snapNumber(spec, v) : v);
}

/**
 * A number input with the schema's range (`min`/`max`, the spec's step: 1 for integers and percents) and the unit as a
 * suffix; a slider beside it when the range is small. Out-of-range values are passed on (the
 * issue line says what is wrong); unparseable text means "not set". The typed text is kept while
 * it still means the current value, so "1." or "-" are not rewritten mid-typing.
 */
export function NumberField(props: FieldProps) {
  const { def, value, onChange, readOnly, autoFocus } = props;
  const spec = def.spec.kind === 'number' ? def.spec : null;
  const text = (v: JsonValue | undefined) => numberText(def.spec, v);
  const [draft, setDraft] = useState(() => text(value));
  const shown = spec && coerce(spec, draft) === value ? draft : text(value);
  // An unset slider sits at the default (or the minimum), muted, and says so.
  const unset = typeof value !== 'number';
  const fallback = (min: number) => (typeof def.default === 'number' ? def.default : min);

  function change(raw: string) {
    setDraft(raw);
    if (spec) onChange(coerce(spec, raw));
  }

  return (
    <Field {...props} unitInLabel={false}>
      {(ids) => (
        <div className="tc-number">
          <div className="tc-number-box">
            <input
              id={ids.id}
              className="input tc-input"
              type="number"
              inputMode={spec?.integer ? 'numeric' : 'decimal'}
              min={spec?.min}
              max={spec?.max}
              step={spec ? numberStep(spec) : 'any'}
              value={shown}
              placeholder={placeholderFor(def)}
              readOnly={readOnly}
              aria-describedby={ids.describedBy}
              aria-invalid={ids.invalid || undefined}
              // biome-ignore lint/a11y/noAutofocus: the inspector focuses a field on request only
              autoFocus={autoFocus}
              onChange={(e) => change(e.target.value)}
            />
            {def.unit && (
              <span className="tc-number-unit" aria-hidden="true">
                {def.unit}
              </span>
            )}
          </div>
          {spec?.slider && spec.min !== undefined && spec.max !== undefined && (
            <>
              <input
                type="range"
                className={unset ? 'tc-slider is-default' : 'tc-slider'}
                aria-labelledby={ids.labelId}
                aria-valuetext={unset ? `${fallback(spec.min)} (default)` : undefined}
                min={spec.min}
                max={spec.max}
                step={numberStep(spec)}
                value={unset ? fallback(spec.min) : text(value)}
                disabled={readOnly}
                onChange={(e) => change(e.target.value)}
              />
              {unset && (
                <span className="tc-slider-default" aria-hidden="true">
                  default
                </span>
              )}
            </>
          )}
        </div>
      )}
    </Field>
  );
}
