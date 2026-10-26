// How the catalog is laid out: plugins grouped by what they are for, and the words on a card.
// Neither the catalog index nor the manifest says what a plugin is for, so the group is a small
// map by plugin name; a plugin it does not know (a custom catalog's) goes under "Other".

export type GroupId = 'media-managers' | 'media-servers' | 'metadata' | 'notifications' | 'other';

export interface PurposeGroup {
  id: GroupId;
  title: string;
  /** The line next to the heading. */
  sub: string;
}

/** In page order. */
export const PURPOSE_GROUPS: readonly PurposeGroup[] = [
  { id: 'media-managers', title: 'Media managers', sub: 'Sonarr, Radarr and friends' },
  { id: 'media-servers', title: 'Media servers', sub: 'Refresh the library after a replace' },
  { id: 'metadata', title: 'Metadata', sub: 'Facts for conditions and actions' },
  { id: 'notifications', title: 'Notifications', sub: 'Hear about finished and failed jobs' },
  { id: 'other', title: 'Other', sub: 'Everything else the catalogs offer' },
];

/** The official catalog's plugins by name. */
const GROUP_OF: Readonly<Record<string, GroupId>> = {
  sonarr: 'media-managers',
  radarr: 'media-managers',
  bazarr: 'media-managers',
  seerr: 'media-managers',
  jellyfin: 'media-servers',
  tmdb: 'metadata',
  discord: 'notifications',
  ntfy: 'notifications',
};

export function groupOf(name: string): GroupId {
  return GROUP_OF[name] ?? 'other';
}

/**
 * A catalog description without its "Sonarr plugin:" lead-in, starting with a capital; a
 * parenthesis in the lead-in ("Seerr plugin (Jellyseerr, Overseerr):") moves to the end.
 */
export function cardDescription(title: string, description: string): string {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${escaped} plugin\\s*(\\([^)]*\\))?\\s*:\\s*`, 'i').exec(description);
  if (!m) return description;
  let rest = description.slice(m[0].length);
  rest = rest.charAt(0).toUpperCase() + rest.slice(1);
  const aside = m[1];
  if (!aside) return rest;
  return rest.endsWith('.') ? `${rest.slice(0, -1)} ${aside}.` : `${rest} ${aside}`;
}

/** The tile's letter when a plugin has no icon: the title's first character, as written. */
export function monogram(title: string): string {
  return Array.from(title.trim())[0] ?? '?';
}

/** "Has subtitles" for `bazarr:has-subtitles`: a node name when the manifest has no title. */
export function nodeNameOf(type: string): string {
  const id = type.slice(type.indexOf(':') + 1).replace(/-+/g, ' ');
  return id.charAt(0).toUpperCase() + id.slice(1);
}
