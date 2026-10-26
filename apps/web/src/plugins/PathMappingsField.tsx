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
 * Path mappings of a plugin integration: the path as the other service sees it (remote) and as
 * Transcoda sees it (local). "Test mapping" asks the server whether the local side is a directory
 * inside a library root.
 */
export function PathMappingsField({
  plugin,
  def,
  value,
  onChange,
  issue,
}: {
  plugin: string;
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
      <legend className="tc-field-label">{def.label}</legend>
      {def.hint ? (
        <span id={`${id}-hint`} className="tc-field-hint">
          {def.hint}
        </span>
      ) : null}
      <table className="plugin-mappings-table">
        <thead>
          <tr>
            <th scope="col" className="plugin-mappings-head">
              Path on the other service
            </th>
            <th scope="col" className="plugin-mappings-head">
              Path on this server
            </th>
            <th scope="col" className="plugin-mappings-head">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={3} className="plugin-mappings-cell muted">
                No mappings: paths are used as they are.
              </td>
            </tr>
          ) : null}
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; edited in place
            <tr key={i}>
              <td className="plugin-mappings-cell">
                <input
                  className="input tc-input mono"
                  aria-label={`Remote path ${i + 1}`}
                  value={row.remote}
                  placeholder="/shows"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => edit(i, { remote: e.target.value })}
                />
              </td>
              <td className="plugin-mappings-cell">
                <input
                  className="input tc-input mono"
                  aria-label={`Local path ${i + 1}`}
                  value={row.local}
                  placeholder="/data/shows"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => edit(i, { local: e.target.value })}
                />
              </td>
              <td className="plugin-mappings-cell plugin-mappings-actions">
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
                  className="btn btn-ghost btn-sm"
                  aria-label={`Remove mapping ${i + 1}`}
                  onClick={() => write(rows.filter((_, j) => j !== i))}
                >
                  <Icon name="trash" size={14} />
                </button>
                {results[i] ? (
                  <span
                    role="status"
                    className={results[i].ok ? 'plugin-test-ok' : 'plugin-test-fail'}
                  >
                    {results[i].message}
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
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
