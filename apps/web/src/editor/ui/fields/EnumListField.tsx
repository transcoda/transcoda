import { useDeviceProfileNames } from './deviceProfiles.ts';
import { Field, type FieldProps, humanise } from './Field.tsx';

/** The engine's device-profile list setting (encode-video, subtitles: `targets`). */
const DEVICE_PROFILE_KEY = 'targets';

/**
 * Several values from an enum as toggle chips (`aria-pressed`), kept in option order. Stored
 * values the schema does not list stay visible (pressed) so they can be removed. `targets` chips
 * are labelled with the device profile names (`system.capabilities`), an unknown id as the id.
 */
export function EnumListField(props: FieldProps) {
  const { def, value, onChange, readOnly, autoFocus } = props;
  const profiles = def.key === DEVICE_PROFILE_KEY;
  const names = useDeviceProfileNames(profiles);
  if (def.spec.kind !== 'enum-list') return null;
  const options = def.spec.options;
  const list = Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
  const all = [...options, ...list.filter((v) => !options.includes(v))];

  function toggle(option: string) {
    const chosen = new Set(list);
    if (chosen.has(option)) chosen.delete(option);
    else chosen.add(option);
    onChange(all.filter((o) => chosen.has(o)));
  }

  return (
    <Field {...props} labelling="group">
      {(ids) => (
        <fieldset
          className="tc-chips"
          aria-labelledby={ids.labelId}
          aria-describedby={ids.describedBy}
        >
          {all.map((o, i) => (
            <button
              key={o}
              type="button"
              className="tc-toggle-chip"
              aria-pressed={list.includes(o)}
              disabled={readOnly}
              // biome-ignore lint/a11y/noAutofocus: the inspector focuses a field on request only
              autoFocus={autoFocus && i === 0}
              onClick={() => toggle(o)}
            >
              {profiles ? (names.get(o) ?? o) : humanise(o)}
            </button>
          ))}
        </fieldset>
      )}
    </Field>
  );
}
