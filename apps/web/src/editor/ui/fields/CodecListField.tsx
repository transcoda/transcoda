import { useState } from 'react';
import { codecName } from '../../../data/codecs.ts';
import { CodecPicker } from '../CodecPicker.tsx';
import { Field, type FieldProps } from './Field.tsx';

/**
 * A codec list (UI list #40): chips with the plain name and the ffmpeg id ("H.264 / AVC h264 ×";
 * a hand-typed id shows as it is) and "Add codec" opening the grouped picker. The stored value is
 * the list of ffmpeg ids, in the order picked.
 */
export function CodecListField(props: FieldProps) {
  const { def, value, onChange, readOnly, autoFocus } = props;
  const [open, setOpen] = useState(false);
  if (def.spec.kind !== 'codec-list') return null;
  const { media } = def.spec;
  const list = Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];

  return (
    <Field {...props} labelling="group">
      {(ids) => (
        <>
          <fieldset
            className="tc-chips"
            aria-labelledby={ids.labelId}
            aria-describedby={ids.describedBy}
          >
            {list.map((id) => {
              const name = codecName(media, id);
              return (
                <span key={id} className="lang-chip">
                  <span>{name}</span>
                  {name !== id && <span className="lang-code">{id}</span>}
                  {!readOnly && (
                    <button
                      type="button"
                      className="tc-chip-remove"
                      aria-label={`Remove ${name}`}
                      onClick={() => onChange(list.filter((c) => c !== id))}
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
                Add codec
              </button>
            )}
            {list.length === 0 && readOnly && <span className="faint">None</span>}
          </fieldset>
          <CodecPicker
            open={open}
            media={media}
            selected={list}
            onToggle={(id) =>
              onChange(list.includes(id) ? list.filter((c) => c !== id) : [...list, id])
            }
            onAddMany={(add) =>
              onChange([
                ...list,
                ...add.filter((id, i) => !list.includes(id) && add.indexOf(id) === i),
              ])
            }
            onClose={() => setOpen(false)}
          />
        </>
      )}
    </Field>
  );
}
