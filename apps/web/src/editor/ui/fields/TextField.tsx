import { useState } from 'react';
import { coerce, isRedactedUrl } from '../../model/schema-fields.ts';
import { Field, type FieldProps, placeholderFor } from './Field.tsx';

/**
 * A text input for `text`, `url` and `password` fields. A password is never read back: the input
 * starts empty (its placeholder says whether one is saved); typing sends the new value, emptying
 * the input or Clear removes it. Note a secret typed here is stored in the workflow graph, so in
 * every saved version.
 *
 * A saved webhook URL arrives redacted (`https://host/…`, see `isRedactedUrl`) and behaves like a
 * saved secret: the input starts empty with "Saved (https://host/…); type to replace", the value
 * stays the redacted form until something is typed (the server keeps the stored URL for it), and
 * emptying the input again goes back to the saved URL rather than removing it.
 */
export function TextField(props: FieldProps) {
  const { def, value, onChange, readOnly, autoFocus } = props;
  const kind = def.spec.kind;
  const [secret, setSecret] = useState('');
  const [seen, setSeen] = useState(value);
  // The redacted form of the stored URL, kept while the user types a replacement.
  const [saved, setSaved] = useState(kind === 'url' && isRedactedUrl(value) ? value : undefined);
  if (seen !== value) {
    // Cleared or replaced from outside (Clear, undo): forget the typed text.
    setSeen(value);
    if (value === undefined) {
      setSecret('');
      setSaved(undefined);
    } else if (kind === 'url' && isRedactedUrl(value)) {
      setSecret('');
      setSaved(value);
    }
  }
  const password = kind === 'password';
  const writeOnly = password || saved !== undefined;
  // A plugin secret the server holds reads back as `{ set: true }`: never "not set", never Clear.
  const stored = password && typeof value === 'object' && value !== null;
  const type = password ? 'password' : kind === 'url' ? 'url' : 'text';
  const placeholder = password
    ? value === undefined
      ? undefined
      : 'Saved; type to replace'
    : saved !== undefined && value === saved
      ? `Saved (${saved}); type to replace`
      : placeholderFor(def);

  function change(raw: string) {
    if (saved !== undefined) {
      setSecret(raw);
      onChange(raw === '' ? saved : coerce(def.spec, raw));
      return;
    }
    if (!password) {
      onChange(coerce(def.spec, raw));
      return;
    }
    setSecret(raw);
    onChange(raw === '' ? undefined : raw);
  }

  return (
    <Field {...props} clearable={!stored} {...(stored ? { notSet: null } : {})}>
      {(ids) => (
        <input
          id={ids.id}
          className="input tc-input"
          type={type}
          inputMode={def.spec.kind === 'text' ? def.spec.inputMode : undefined}
          value={writeOnly ? secret : typeof value === 'string' ? value : ''}
          placeholder={placeholder}
          autoComplete={password ? 'new-password' : saved !== undefined ? 'off' : undefined}
          spellCheck={type === 'text' ? undefined : false}
          readOnly={readOnly}
          aria-describedby={ids.describedBy}
          aria-invalid={ids.invalid || undefined}
          // biome-ignore lint/a11y/noAutofocus: the inspector focuses a field on request only
          autoFocus={autoFocus}
          onChange={(e) => change(e.target.value)}
        />
      )}
    </Field>
  );
}
