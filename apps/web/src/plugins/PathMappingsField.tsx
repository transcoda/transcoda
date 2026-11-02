import type { JsonValue } from '@transcoda/shared';
import { useId, useState } from 'react';
import { api, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Icon } from '../components/Icon.tsx';
import type { FieldDef } from '../editor/model/schema-fields.ts';

type Mapping = { remote: string; local: string };

function mappingsOf(value: JsonValue | undefined): Mapping[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return [];
    const { remote, local } = row;
    return [
      {
        remote: typeof remote === 'string' ? remote : '',
        local: typeof local === 'string' ? local : '',
      },
    ];
  });
}

/**
 * The help line above the mappings. Transcoda words it, not the plugin, so it always reads in the
 * order of the fields below it (a plugin's own description once had the direction backwards, #46).
 */
export function mappingsHint(service: string): string {
  return `Each mapping is one folder: first the path as ${service} sees it, then the same folder as Transcoda sees it. Leave empty when both see the same folders.`;
}

/**
 * Path mappings of a plugin integration: the path as the other service sees it (remote) and as
 * Transcoda sees it (local). Each mapping is a block of its own: a labelled, full-width input per
 * side, then its buttons, then the "Test mapping" answer (whether the local side is a directory
 * inside a library root), so nothing runs past the card on a phone.
 */
export function PathMappingsField({
  plugin,
  service = plugin,
  def,
  value,
  onChange,
  issue,
}: {
  plugin: string;
  /** The plugin's display name ("Jellyfin"), for the labels. */
  service?: string;
  def: FieldDef;
  value: JsonValue | undefined;
  onChange(v: JsonValue | undefined): void;
  issue: string | null;
}) {
  const id = useId();
  const rows = mappingsOf(value);
  const [results, setResults] = useState<Record<number, { ok: boolean; message: string }>>({});
  const [testing, setTesting] = useState<number | null>(null);

  const write = (next: Mapping[]) => {
    setResults({});
    onChange(next.map((m) => ({ remote: m.remote, local: m.local })));
  };
  const edit = (i: number, patch: Partial<Mapping>) =>
    write(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function test(i: number) {
    const row = rows[i];
    if (!row || testing !== null) return;
    setTesting(i);
    const [err, out] = await safe(api.plugins.testMapping({ name: plugin, mapping: row }));
    setTesting(null);
    setResults((r) => ({
      ...r,
      [i]: err
        ? { ok: false, message: describeError(err).message }
        : (out ?? { ok: false, message: '' }),
    }));
  }

  return (
    <fieldset
      className="tc-field plugin-mappings"
      data-field={def.key}
      aria-describedby={`${id}-hint`}
    >
      <legend className="tc-field-label">Path mappings</legend>
      <span id={`${id}-hint`} className="tc-field-hint">
        {mappingsHint(service)}
      </span>
      {rows.length === 0 ? (
        <p className="plugin-mappings-empty">No mappings: paths are used as they are.</p>
      ) : null}
      {rows.map((row, i) => {
        const result = results[i];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; edited in place
          <fieldset key={i} className="plugin-mapping">
            <legend className="plugin-mapping-title">{`Mapping ${i + 1}`}</legend>
            <div className="plugin-mapping-fields">
              <div className="tc-field">
                <label className="tc-field-label" htmlFor={`${id}-remote-${i}`}>
                  {`Path in ${service}`}
                </label>
                <input
                  id={`${id}-remote-${i}`}
                  className="input tc-input mono"
                  value={row.remote}
                  placeholder="/shows"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => edit(i, { remote: e.target.value })}
                />
              </div>
              <div className="tc-field">
                <label className="tc-field-label" htmlFor={`${id}-local-${i}`}>
                  Path in Transcoda
                </label>
                <input
                  id={`${id}-local-${i}`}
                  className="input tc-input mono"
                  value={row.local}
                  placeholder="/data/shows"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => edit(i, { local: e.target.value })}
                />
              </div>
            </div>
            <div className="plugin-mapping-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={`Test mapping ${i + 1}`}
                disabled={testing !== null}
                onClick={() => void test(i)}
              >
                Test mapping
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm plugin-mapping-remove"
                aria-label={`Remove mapping ${i + 1}`}
                title="Remove mapping"
                onClick={() => write(rows.filter((_, j) => j !== i))}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
            {result ? (
              <div
                role="status"
                className={result.ok ? 'plugin-test-result is-ok' : 'plugin-test-result is-fail'}
              >
                <Icon name={result.ok ? 'check' : 'cross'} size={16} strokeWidth={2.4} round />
                <span className="plugin-test-line">{result.message}</span>
              </div>
            ) : null}
          </fieldset>
        );
      })}
      <button
        type="button"
        className="btn btn-secondary btn-sm plugin-mappings-add"
        onClick={() => write([...rows, { remote: '', local: '' }])}
      >
        <Icon name="plus" size={14} strokeWidth={2.6} />
        Add mapping
      </button>
      {issue ? (
        <p className="tc-field-issue">
          <Icon name="alert" size={14} round />
          {issue}
        </p>
      ) : null}
    </fieldset>
  );
}
