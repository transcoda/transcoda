import { useLibraries } from '../../../hooks/useLibraries.ts';
import { Field, type FieldProps } from './Field.tsx';
import { LibrarySelect, libraryName } from './LibrarySelect.tsx';
import { TextField } from './TextField.tsx';

/**
 * The Library trigger's `libraryId` as a select of library names, the same control as on the card.
 * A stored id that no library has stays selected with a warning. While the list loads the field is
 * the plain text field, and it stays that if the list cannot be loaded, so the setting is always
 * editable.
 */
export function LibraryField(props: FieldProps) {
  const { value, onChange, readOnly, autoFocus, issue } = props;
  const { libraries, error } = useLibraries();
  if (!libraries || error) return <TextField {...props} />;
  const id = typeof value === 'string' ? value : '';
  const missing = id !== '' && libraryName(libraries, id) === undefined;
  return (
    <Field {...props} issue={issue ?? (missing ? 'This library no longer exists' : null)}>
      {(ids) => (
        <LibrarySelect
          libraries={libraries}
          id={ids.id}
          value={id}
          className="input tc-input"
          disabled={readOnly}
          describedBy={ids.describedBy}
          invalid={ids.invalid}
          autoFocus={autoFocus}
          onChange={onChange}
        />
      )}
    </Field>
  );
}
