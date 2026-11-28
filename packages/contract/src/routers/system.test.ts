import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CapabilitiesSchema,
  errorDefs,
  HealthInputSchema,
  LicencesOutputSchema,
  ThirdPartyFileSchema,
} from '../index.ts';

describe('system router', () => {
  it('accepts an unavailable capabilities report', () => {
    expect(
      CapabilitiesSchema.safeParse({
        available: false,
        path: '/x',
        error: 'ENOENT',
        deviceProfiles: [{ id: 'chrome', name: 'Chrome (desktop)' }],
      }).success,
    ).toBe(true);
  });

  it('requires deviceProfiles in both capabilities variants', () => {
    expect(
      CapabilitiesSchema.safeParse({ available: false, path: '/x', error: 'ENOENT' }).success,
    ).toBe(false);
    const available = {
      available: true,
      path: '/usr/bin/ffmpeg',
      version: '9.0.2',
      encoders: [],
      hwaccels: [],
      filters: [],
    };
    expect(CapabilitiesSchema.safeParse(available).success).toBe(false);
    expect(CapabilitiesSchema.safeParse({ ...available, deviceProfiles: [] }).success).toBe(true);
    expect(
      CapabilitiesSchema.safeParse({ ...available, deviceProfiles: [{ id: 'tv', name: 'TV' }] })
        .success,
    ).toBe(false);
  });

  it('health takes an optional deep query and can answer UNHEALTHY with the checks', () => {
    expect(HealthInputSchema.safeParse(undefined).success).toBe(true);
    expect(HealthInputSchema.safeParse({}).success).toBe(true);
    expect(HealthInputSchema.safeParse({ deep: '1' }).success).toBe(true);
    expect(HealthInputSchema.safeParse({ deep: 'true' }).success).toBe(true);
    expect(HealthInputSchema.safeParse({ deep: 'yes' }).success).toBe(false);
    expect(errorDefs.UNHEALTHY.status).toBe(503);
    expect(
      errorDefs.UNHEALTHY.data.safeParse({
        status: 'fail',
        version: '1',
        checks: { database: 'ok', ffmpeg: 'fail', scratchSpace: 'ok', queue: 'ok' },
      }).success,
    ).toBe(true);
  });
});

describe('licences', () => {
  // The fixture the licence generator's own tests produce: both sides agree on one format.
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../../scripts/fixtures/licences/expected-third-party.json', import.meta.url),
      'utf8',
    ),
  );

  it('parses the generator fixture', () => {
    const parsed = ThirdPartyFileSchema.parse(fixture);
    expect(parsed.packages.length).toBeGreaterThan(0);
    for (const p of parsed.packages) expect(parsed.texts[p.textKey]).toBeTypeOf('string');
  });

  it('licences output is the file plus available, or available false alone', () => {
    expect(LicencesOutputSchema.parse({ ...fixture, available: true }).available).toBe(true);
    expect(LicencesOutputSchema.parse({ available: false })).toEqual({ available: false });
    expect(LicencesOutputSchema.safeParse({ available: true }).success).toBe(false);
  });

  it('rejects an unknown origin and another format', () => {
    const pkg = fixture.packages[0];
    expect(
      ThirdPartyFileSchema.safeParse({ ...fixture, packages: [{ ...pkg, origin: 'cdn' }] }).success,
    ).toBe(false);
    expect(ThirdPartyFileSchema.safeParse({ ...fixture, format: 2 }).success).toBe(false);
  });
});
