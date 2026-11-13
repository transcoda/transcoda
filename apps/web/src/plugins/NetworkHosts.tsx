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
 * promises. `added` marks the entries an update brings (a "new" badge on each).
 */
export function NetworkHosts({
  network,
  added = [],
}: {
  /** Null: the build predates the list. */
  network: readonly NetworkEntry[] | null;
  added?: readonly NetworkEntry[];
}) {
  const id = useId();
  const fresh = new Set(added.map(keyOf));
  return (
    <section className="plugin-network" aria-labelledby={id}>
      <h3 id={id} className="plugin-network-title">
        Connects to
      </h3>
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
