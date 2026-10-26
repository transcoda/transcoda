import { useState } from 'react';
import { api, safe } from '../api/client.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Icon } from '../components/Icon.tsx';
import { InfoTip } from '../components/InfoTip.tsx';
import { pluginFailure } from './errors.ts';
import {
  ATTESTATION_TIP,
  CUSTOM_CATALOG_WARNING,
  provenanceSignature,
  provenanceSource,
  SECURITY_PROMISE,
  webLink,
} from './pluginText.ts';
import type { CatalogView } from './usePlugins.ts';

export type Entry = CatalogView['plugins'][number];
export type Version = Entry['versions'][number];

/** One build to install: the catalog it comes from, its entry and the version. */
export interface Target {
  catalog: CatalogView;
  entry: Entry;
  version: Version;
}

/** Where the build comes from and what a plugin can do, then Install (focus starts on Cancel). */
export function InstallDialog({
  target,
  returnFocusTo,
  onClose,
  onInstalled,
}: {
  target: Target | null;
  returnFocusTo: HTMLElement | null;
  onClose(): void;
  onInstalled(name: string): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function close() {
    if (pending) return;
    setError(null);
    onClose();
  }

  async function install() {
    if (!target || pending) return;
    setPending(true);
    setError(null);
    const [err] = await safe(
      api.plugins.install({
        name: target.entry.name,
        version: target.version.version,
        catalogUrl: target.catalog.catalogUrl,
      }),
    );
    setPending(false);
    if (err) {
      const reason = pluginFailure(err).replace(/\.$/, '');
      setError(
        `${target.entry.title} didn't install: ${reason.charAt(0).toUpperCase()}${reason.slice(1)}. Its output is in the server log; try again once that is fixed.`,
      );
      return;
    }
    onInstalled(target.entry.name);
  }

  const attestation = webLink(target?.version.attestation ?? null);
  const paragraphs = SECURITY_PROMISE.split('\n\n');
  return (
    <Dialog
      open={target !== null}
      showClose
      title={target ? `Install ${target.entry.title} ${target.version.version}?` : 'Install'}
      returnFocusTo={returnFocusTo}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={close} data-autofocus>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            onClick={() => void install()}
          >
            Install
          </button>
        </>
      }
    >
      {target ? (
        <dl className="plugin-facts" aria-label="Where this plugin comes from">
          <div>
            <dt>Source</dt>
            <dd>{provenanceSource(target.catalog.official)}</dd>
          </div>
          <div>
            <dt>Signature</dt>
            <dd>{provenanceSignature(target.catalog.keyIds)}</dd>
          </div>
          <div>
            <dt>SHA-256</dt>
            <dd className="mono" title={target.version.sha256}>
              {target.version.sha256.slice(0, 12)}
            </dd>
          </div>
          {attestation ? (
            <div>
              <dt>
                Attestation
                <InfoTip label="What is an attestation?" text={ATTESTATION_TIP} />
              </dt>
              <dd>
                <a href={attestation} target="_blank" rel="noopener noreferrer">
                  View on GitHub
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {target && !target.catalog.official && target.catalog.keyIds.length === 0 ? (
        <div className="alert alert-warning" role="note">
          <Icon name="alert" size={16} round />
          <span>{CUSTOM_CATALOG_WARNING}</span>
        </div>
      ) : null}
      <details className="plugin-promise">
        <summary>What a plugin can and cannot do</summary>
        {paragraphs.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </details>
      {error ? (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>{error}</span>
        </div>
      ) : null}
    </Dialog>
  );
}
