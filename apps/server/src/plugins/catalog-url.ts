/** A leaf module: config.ts needs the default without pulling in the catalog client. */
export const OFFICIAL_CATALOG_URL =
  'https://raw.githubusercontent.com/transcoda/transcoda-plugins/catalog/index.json';

/** Beside the catalog index; same key, same CI. */
export const OFFICIAL_BLOCKLIST_URL =
  'https://raw.githubusercontent.com/transcoda/transcoda-plugins/catalog/blocklist.json';
