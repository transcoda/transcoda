import { describe, expect, it } from 'vitest';
import { OFFICIAL_BLOCKLIST_URL } from './catalog-url.ts';
import {
  BLOCKLIST_INERT_WARNING,
  blocklistInertWarning,
  OFFICIAL_SIGNING_KEYS,
} from './official-keys.ts';

describe('blocklistInertWarning', () => {
  const other = [{ id: 'mine', publicKey: 'a'.repeat(64) }];

  it('has the exact text', () => {
    expect(BLOCKLIST_INERT_WARNING).toBe(
      'the official plugin blocklist is configured but TRANSCODA_PLUGIN_CATALOG_KEY replaces the official signing keys: the blocklist is inert and blocks nothing',
    );
  });

  it('warns for the official url with keys other than the official ones', () => {
    expect(blocklistInertWarning(OFFICIAL_BLOCKLIST_URL, other)).toBe(BLOCKLIST_INERT_WARNING);
  });

  it('is silent with the official keys, with unsigned development (null), or a custom url', () => {
    expect(blocklistInertWarning(OFFICIAL_BLOCKLIST_URL, [...OFFICIAL_SIGNING_KEYS])).toBeNull();
    expect(blocklistInertWarning(OFFICIAL_BLOCKLIST_URL, null)).toBeNull();
    expect(blocklistInertWarning('https://example.test/blocklist.json', other)).toBeNull();
  });
});
