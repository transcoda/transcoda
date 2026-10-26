import { KIND_WORD } from '../components/Chips.tsx';
import type { NodeKind } from '../hooks/useCatalog.ts';
import { monogram, nodeNameOf } from './pluginGroups.ts';

/**
 * The 40px tile in front of a plugin's name: its own SVG icon, shown only as an image (an SVG in
 * an `<img>` runs no script and loads nothing), or the title's first letter. Decorative: the name
 * next to it says which plugin it is.
 */
export function PluginTile({ title, icon }: { title: string; icon: string | null }) {
  const src = icon ? iconUrl(icon) : null;
  return (
    <span className="plugin-tile" aria-hidden="true">
      {src ? <img src={src} alt="" width={28} height={28} /> : monogram(title)}
    </span>
  );
}

/** The icon as a data URL; null when it cannot be encoded (a lone surrogate): the monogram shows. */
function iconUrl(icon: string): string | null {
  try {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon)}`;
  } catch {
    return null;
  }
}

export interface NodeChip {
  type: string;
  kind: NodeKind | null;
  title: string | null;
}

/**
 * The nodes a plugin adds: the kind's colour and word, then the node's name. A manifest that
 * predates node info has neither kind nor title: the chip is neutral and names the node by its type.
 */
export function NodeChips({ nodes, label }: { nodes: readonly NodeChip[]; label: string }) {
  if (nodes.length === 0) return null;
  return (
    <ul className="node-chips" aria-label={label}>
      {nodes.map((n) => (
        <li key={n.type} className={n.kind ? `node-chip is-${n.kind}` : 'node-chip'}>
          <span className="node-chip-swatch" aria-hidden="true" />
          {n.kind ? (
            <>
              <span className="node-chip-kind">{KIND_WORD[n.kind]}</span>
              <span className="sr-only">: </span>
            </>
          ) : null}
          {n.title ?? nodeNameOf(n.type)}
        </li>
      ))}
    </ul>
  );
}
