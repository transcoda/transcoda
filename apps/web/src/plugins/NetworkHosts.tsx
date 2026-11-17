import { useId } from 'react';
import {
  networkKey as keyOf,
  NETWORK_NONE,
  NETWORK_NOTE,
  NETWORK_UNLISTED,
  type NetworkEntry,
  networkEntryText,
} from './pluginText.ts';

/**
 * "Connects to": the hosts a build may reach through Transcoda's HTTP client, with what that
 * promises. `added` marks the entries an update brings (a "new" badge on each). Shown by the
 * install and update dialogs and on an installed plugin's row.
 */
export function NetworkHosts({
  network,
  added = [],
  level = 3,
}: {
  /** Null: the build predates the list. */
  network: readonly NetworkEntry[] | null;
  added?: readonly NetworkEntry[];
  /** The heading's level: 3 in a dialog, 4 under a plugin row's name. */
  level?: 3 | 4;
}) {
  const id = useId();
  const Heading = level === 4 ? 'h4' : 'h3';
  const fresh = new Set(added.map(keyOf));
  return (
    <section className="plugin-network" aria-labelledby={id}>
      <Heading id={id} className="plugin-network-title">
        Connects to
      </Heading>
      {network === null ? (
        <p className="plugin-network-unlisted">{NETWORK_UNLISTED}</p>
      ) : (
        <>
          <ul aria-labelledby={id} className="plugin-network-list">
            {network.length === 0 ? <li>{NETWORK_NONE}</li> : null}
            {network.map((e) => (
              <li key={keyOf(e)} className={fresh.has(keyOf(e)) ? 'is-new' : undefined}>
                <span className={'origin' in e ? 'mono' : undefined}>{networkEntryText(e)}</span>
                {fresh.has(keyOf(e)) ? <span className="plugin-network-new">new</span> : null}
              </li>
            ))}
          </ul>
          <p className="plugin-network-note">{NETWORK_NOTE}</p>
        </>
      )}
    </section>
  );
}
