import { Field, type FieldProps } from './Field.tsx';

/**
 * A switch (`role="switch"`). An unset value shows the schema default, which the server applies
 * (else off), so a default-on setting never reads as off.
 */
export function BooleanField(props: FieldProps) {
  const { value, onChange, readOnly, autoFocus } = props;
  const { def } = props;
  const on = value === undefined ? def.default === true : value === true;
  const help = def.spec.kind === 'boolean' ? def.spec.help : undefined;
  return (
    <Field {...props} def={help && !def.hint ? { ...def, hint: help } : def}>
      {(ids) => (
        <button
          id={ids.id}
          type="button"
          role="switch"
          className="tc-switch"
          aria-checked={on}
          aria-describedby={ids.describedBy}
          aria-invalid={ids.invalid || undefined}
          disabled={readOnly}
          // biome-ignore lint/a11y/noAutofocus: the inspector focuses a field on request only
          autoFocus={autoFocus}
          onClick={() => onChange(!on)}
        >
          <span className="tc-switch-knob" />
        </button>
      )}
    </Field>
  );
}
