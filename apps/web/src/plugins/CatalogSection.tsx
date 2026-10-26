import { useId } from 'react';
import { Icon } from '../components/Icon.tsx';
import type { Entry, Target, Version } from './InstallDialog.tsx';
import { NodeChips, PluginTile } from './PluginTile.tsx';
import {
  cardDescription,
  groupOf,
  nodeNameOf,
  PURPOSE_GROUPS,
  type PurposeGroup,
} from './pluginGroups.ts';
import type { CatalogView } from './usePlugins.ts';

/** Semver order of two versions (build metadata ignored); negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = (v.split('+')[0] ?? '').split(/-(.*)/s);
    return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  // A release outranks its pre-releases.
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** The build a card's Install offers: the entry's latest version, null when there is none. */
export function latestVersion(entry: Entry): Version | null {
  return entry.versions.find((v) => v.version === entry.latest) ?? null;
}

/** One plugin of one catalog, as a card. */
export interface CatalogCard {
  catalog: CatalogView;
  entry: Entry;
  /** The latest compatible version; null when no version runs on this server. */
  version: Version | null;
}

/** Whether every word of `query` is in one of `texts` (case does not matter). */
export function matchesQuery(query: string, texts: ReadonlyArray<string | null>): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = texts
    .filter((t) => t !== null)
    .join(' ')
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/**
 * The catalogs' plugins as cards grouped by purpose, in group order and by title within a group;
 * only the cards that match `query`, and no empty group.
 */
export function catalogCards(
  catalogs: readonly CatalogView[],
  query: string,
): Array<{ group: PurposeGroup; cards: CatalogCard[] }> {
  const cards = catalogs
    .flatMap((catalog) =>
      catalog.plugins.map((entry) => ({ catalog, entry, version: latestVersion(entry) })),
    )
    .filter(({ entry }) =>
      matchesQuery(query, [
        entry.title,
        entry.name,
        entry.description,
        ...entry.nodes.map((n) => n.title ?? nodeNameOf(n.type)),
      ]),
    )
    .sort((a, b) => a.entry.title.localeCompare(b.entry.title));
  return PURPOSE_GROUPS.map((group) => ({
    group,
    cards: cards.filter((c) => groupOf(c.entry.name) === group.id),
  })).filter((g) => g.cards.length > 0);
}

/** The host of a catalog url, for telling two catalogs' cards apart. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Why a card cannot be installed, or null when it can. */
function blockedReasonOf(card: CatalogCard): string | null {
  if (card.version?.blocked) return `Blocklisted: ${card.version.blocked.reason}`;
  if (card.version) return null;
  const newest = [...card.entry.versions].sort((a, b) => compareVersions(b.version, a.version))[0];
  return newest ? `Needs SDK ${newest.sdk}` : 'No version to install';
}

function CatalogCardView({
  card,
  onInstall,
}: {
  card: CatalogCard;
  onInstall(target: Target, opener: HTMLElement): void;
}) {
  const id = useId();
  const { catalog, entry, version } = card;
  const reason = blockedReasonOf(card);
  const shownVersion = version?.version ?? entry.latest;
  const install = version
    ? catalog.official
      ? `Install ${entry.title} ${version.version}`
      : `Install ${entry.title} ${version.version} from ${hostOf(catalog.catalogUrl)}`
    : `Install ${entry.name}`;
  return (
    <li>
      <article className="catalog-card" aria-labelledby={`${id}-title`}>
        <div className="catalog-card-head">
          <PluginTile title={entry.title} icon={entry.icon} />
          <div className="catalog-card-name">
            <h3 id={`${id}-title`}>{entry.title}</h3>
            <span className="catalog-card-ids">
              <span className="mono">{entry.name}</span>
              {shownVersion ? <span className="mono">{shownVersion}</span> : null}
            </span>
          </div>
          {entry.installed !== null ? (
            <span className="catalog-card-installed">
              <Icon name="check" size={13} strokeWidth={2.8} round />
              Installed
            </span>
          ) : (
            // Secondary on the card: the install dialog holds the one primary action.
            <button
              type="button"
              className="btn btn-secondary"
              aria-label={install}
              disabled={version === null || version.blocked !== null}
              {...(reason ? { 'aria-describedby': `${id}-reason` } : {})}
              onClick={(e) => {
                if (version) onInstall({ catalog, entry, version }, e.currentTarget);
              }}
            >
              Install
            </button>
          )}
        </div>
        <p className="catalog-card-text">{cardDescription(entry.title, entry.description)}</p>
        <NodeChips nodes={entry.nodes} label={`Nodes ${entry.title} adds`} />
        {catalog.official ? null : (
          <p className="catalog-card-source">
            {'From '}
            <span className="mono">{hostOf(catalog.catalogUrl)}</span>
          </p>
        )}
        {reason && entry.installed === null ? (
          <p id={`${id}-reason`} className="catalog-needs">
            {reason}
          </p>
        ) : null}
      </article>
    </li>
  );
}

/** The catalog's cards, one section per purpose. */
export function CatalogGroups({
  groups,
  onInstall,
}: {
  groups: ReturnType<typeof catalogCards>;
  onInstall(target: Target, opener: HTMLElement): void;
}) {
  return (
    <>
      {groups.map(({ group, cards }) => (
        <section key={group.id} className="plugins-section" aria-labelledby={`group-${group.id}`}>
          <div className="plugins-group-head">
            <h2 id={`group-${group.id}`}>{group.title}</h2>
            <span>{group.sub}</span>
          </div>
          <ul className="catalog-grid">
            {cards.map((card) => (
              <CatalogCardView
                key={`${card.catalog.catalogUrl} ${card.entry.name}`}
                card={card}
                onInstall={onInstall}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
