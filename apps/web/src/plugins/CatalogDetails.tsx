import { type FormEvent, useId, useState } from 'react';
import { api, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { DisabledReason, RequiredMark } from '../components/Form.tsx';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';
import { fmtAgo } from '../lib/time.ts';
import { pluginFailure } from './errors.ts';
import { CUSTOM_CATALOG_WARNING, provenanceSignature } from './pluginText.ts';
import type { CatalogView, PluginCatalogOutput } from './usePlugins.ts';

/** Plain words for a catalog that did not load; the raw reason stays in the alert's tooltip. */
export const CATALOG_UNREADABLE =
  "Couldn't load this catalog. Check that the address is right and that Transcoda can reach it.";
export const CATALOG_UNAVAILABLE =
  "Couldn't load the catalog. Check your connection to the server and try again.";
export const BLOCKLIST_UNAVAILABLE =
  "Couldn't check the blocklist, so Transcoda can't flag blocked plugins right now.";

/** Add a catalog by URL; the warning comes first, the input after it. */
function AddCatalogForm({ onAdded }: { onAdded(out: PluginCatalogOutput): void }) {
  const id = useId();
  const [url, setUrl] = useState('');
  const [signingKeys, setSigningKeys] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (url.trim() === '') return;
    setPending(true);
    setError(null);
    const key = signingKeys.trim();
    const [err, out] = await safe(
      api.plugins.catalogsAdd(
        key === '' ? { url: url.trim() } : { url: url.trim(), signingKeys: key },
      ),
    );
    setPending(false);
    if (err || !out) {
      setError(pluginFailure(err));
      return;
    }
    setUrl('');
    setSigningKeys('');
    onAdded(out);
  }

  return (
    <form className="panel catalog-add" onSubmit={(e) => void submit(e)} noValidate>
      <h3>Add a custom catalog</h3>
      <div className="alert alert-warning" role="note">
        <Icon name="alert" size={16} round />
        <span>{CUSTOM_CATALOG_WARNING}</span>
      </div>
      <div className="field">
        <label htmlFor={`${id}-url`}>
          Catalog URL
          <RequiredMark />
        </label>
        <input
          id={`${id}-url`}
          className="input mono"
          type="url"
          inputMode="url"
          required
          aria-required="true"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          placeholder="https://example.com/plugins/index.json"
          value={url}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setUrl(e.target.value)}
        />
        {error ? (
          <span id={`${id}-error`} className="lib-field-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor={`${id}-key`}>Signing key (id:hex)</label>
        <input
          id={`${id}-key`}
          className="input mono"
          type="text"
          aria-describedby={`${id}-key-hint`}
          placeholder="keyId:0123abcd…"
          value={signingKeys}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setSigningKeys(e.target.value)}
        />
        <span id={`${id}-key-hint`} className="field-hint">
          Optional. A signed catalog comes with a key: a name, a colon and 64 hex characters. Leave
          this empty for an unsigned catalog.
        </span>
      </div>
      <div>
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={pending || url.trim() === ''}
          {...(url.trim() === '' ? { 'aria-describedby': `${id}-reason` } : {})}
        >
          Add catalog
        </button>
      </div>
      {url.trim() === '' ? (
        <DisabledReason id={`${id}-reason`}>Enter the catalog URL</DisabledReason>
      ) : null}
    </form>
  );
}

/**
 * The collapsed end of the page: each catalog's full address, how it is signed and when it was
 * read (custom ones can be removed), the blocklist, and the form to add a catalog.
 */
export function CatalogDetails({
  catalogs,
  blocklist,
  onCatalogs,
}: {
  catalogs: CatalogView[] | undefined;
  blocklist: PluginCatalogOutput['blocklist'] | undefined;
  onCatalogs(out: PluginCatalogOutput): void;
}) {
  const toast = useToast();

  async function removeCatalog(url: string) {
    const [err, out] = await safe(api.plugins.catalogsRemove({ url }));
    if (err || !out) toast.error(`Couldn't remove the catalog: ${describeError(err).message}`);
    else onCatalogs(out);
  }

  return (
    <details className="catalog-details">
      <summary>Catalog details</summary>
      <div className="catalog-details-body">
        {catalogs && catalogs.length > 0 ? (
          <ul className="catalog-sources" aria-label="Catalogs">
            {catalogs.map((c) => (
              <li key={c.catalogUrl} className="catalog-source">
                <span className="mono catalog-url">{c.catalogUrl}</span>
                <span className="catalog-source-facts">
                  {c.official ? <span className="chip chip-ok">official</span> : null}
                  <span>{provenanceSignature(c.keyIds)}</span>
                  {c.error ? (
                    <span className="catalog-needs" title={c.error}>
                      not loaded
                    </span>
                  ) : c.fetchedAt ? (
                    <span>{`checked ${fmtAgo(c.fetchedAt)}`}</span>
                  ) : null}
                </span>
                {c.official ? null : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={`Remove catalog ${c.catalogUrl}`}
                    onClick={() => void removeCatalog(c.catalogUrl)}
                  >
                    Remove catalog
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {blocklist && !blocklist.error ? (
          <p>
            {`Blocklist: ${blocklist.entries} ${blocklist.entries === 1 ? 'entry' : 'entries'}, checked ${blocklist.fetchedAt ? fmtAgo(blocklist.fetchedAt) : 'never'}`}
          </p>
        ) : null}
        {blocklist ? (
          <p>
            {'Blocklist address: '}
            <span className="mono catalog-url">{blocklist.url}</span>
          </p>
        ) : null}
        <p>{"Older versions can be installed from a plugin's settings."}</p>
        <AddCatalogForm onAdded={onCatalogs} />
      </div>
    </details>
  );
}
