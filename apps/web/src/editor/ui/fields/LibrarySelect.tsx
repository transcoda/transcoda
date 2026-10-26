import type { LibraryChoice } from '../../../hooks/useLibraries.ts';

export const MISSING_LIBRARY = 'Missing library';

/** The library a stored id names, or undefined when no library has that id. */
export const libraryName = (libraries: LibraryChoice[], id: string) =>
  libraries.find((l) => l.id === id)?.name;

/**
 * The one Library select, on the card and in the inspector: library names, "—" while unset, and a
 * stored id that no library has stays selected as "Missing library" rather than being dropped.
 */
export function LibrarySelect({
  libraries,
  id,
  value,
  className,
  disabled,
  describedBy,
  invalid,
  autoFocus,
  onChange,
}: {
  libraries: LibraryChoice[];
  id?: string;
  value: string;
  className: string;
  disabled: boolean;
  describedBy?: string | undefined;
  invalid?: boolean;
  autoFocus?: boolean | undefined;
  onChange(libraryId: string): void;
}) {
  const missing = value !== '' && libraryName(libraries, value) === undefined;
  return (
    <select
      id={id}
      className={className}
      value={value}
      disabled={disabled}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      // biome-ignore lint/a11y/noAutofocus: the inspector focuses a field on request only
      autoFocus={autoFocus}
      onChange={(e) => {
        if (e.target.value !== '') onChange(e.target.value);
      }}
    >
      {value === '' && <option value="">—</option>}
      {missing && <option value={value}>{MISSING_LIBRARY}</option>}
      {libraries.map((l) => (
        <option key={l.id} value={l.id}>
          {l.name}
        </option>
      ))}
    </select>
  );
}
