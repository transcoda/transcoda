import { type KeyboardEvent, useState } from 'react';
import { Dialog } from '../../components/Dialog.tsx';
import { LANGUAGES } from '../../data/languages.ts';

/**
 * What `onPick` receives for "Original (from data)" (offered only with `originalOption`, off by
 * default). Not a valid language code; the caller must map it to a real settings value, never to
 * "unset" (unset means any language).
 */
export const ORIGINAL_FROM_DATA = 'original';
const ORIGINAL_LABEL = 'Original (from data)';

/** Exact code first, then names starting with the query, then the rest (table order). */
function matches(query: string, exclude: string[]) {
  const q = query.trim().toLowerCase();
  const pool = LANGUAGES.filter((l) => !exclude.includes(l.code));
  if (q === '') return pool;
  const rank = (l: { code: string; name: string }) => {
    const name = l.name.toLowerCase();
    if (l.code === q) return 0;
    if (name.startsWith(q)) return 1;
    if (l.code.startsWith(q)) return 2;
    return name.includes(q) ? 3 : -1;
  };
  return pool
    .map((l) => ({ l, r: rank(l) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.l);
}

/**
 * A dialog with a search over the language table ("German de"); Enter picks the first match.
 * `exclude` hides codes already chosen. `originalOption` adds "Original (from data)" first,
 * which picks `ORIGINAL_FROM_DATA`.
 */
export function LanguagePicker({
  open,
  exclude,
  onPick,
  onClose,
  originalOption = false,
  title = 'Pick a language',
}: {
  open: boolean;
  exclude: string[];
  onPick(code: string): void;
  onClose(): void;
  originalOption?: boolean;
  title?: string;
}) {
  const [query, setQuery] = useState('');
  const found = matches(query, exclude);
  const q = query.trim().toLowerCase();
  const showOriginal = originalOption && (q === '' || ORIGINAL_LABEL.toLowerCase().includes(q));

  function pick(code: string) {
    setQuery('');
    onPick(code);
  }

  function close() {
    setQuery('');
    onClose();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const first = showOriginal ? ORIGINAL_FROM_DATA : found[0]?.code;
    if (first !== undefined) pick(first);
  }

  return (
    <Dialog
      open={open}
      title={title}
      onClose={close}
      footer={
        <button type="button" className="btn btn-secondary btn-sm" onClick={close}>
          Cancel
        </button>
      }
    >
      <div className="lang-picker">
        <input
          type="search"
          className="input tc-input"
          aria-label="Search languages"
          placeholder="Name or code"
          value={query}
          data-autofocus
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {!showOriginal && found.length === 0 ? (
          <p className="lang-picker-empty">No language matches</p>
        ) : (
          <ul className="lang-picker-list">
            {showOriginal && (
              <li>
                <button
                  type="button"
                  className="lang-picker-option is-original"
                  onClick={() => pick(ORIGINAL_FROM_DATA)}
                >
                  {ORIGINAL_LABEL}
                </button>
              </li>
            )}
            {found.map((l) => (
              <li key={l.code}>
                <button type="button" className="lang-picker-option" onClick={() => pick(l.code)}>
                  {l.name} {l.code !== 'unknown' && <span className="lang-code">{l.code}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
