import type { ThirdPartyPackage } from '@transcoda/contract';
import { describe, expect, it } from 'vitest';
import { filterLicences } from './licenceSearch.ts';

const pkg = (name: string, licence: string): ThirdPartyPackage => ({
  name,
  version: '1.0.0',
  licence,
  homepage: null,
  origin: 'npm',
  usedBy: ['web'],
  textKey: 'sha256:x',
});

const all = [
  pkg('@xyflow/react', 'MIT'),
  pkg('qs', 'BSD-3-Clause'),
  pkg('type-fest', '(MIT OR CC0-1.0)'),
];

describe('filterLicences', () => {
  it('an empty or blank query keeps every package', () => {
    expect(filterLicences(all, '')).toEqual(all);
    expect(filterLicences(all, '   ')).toEqual(all);
  });

  it('matches the name', () => {
    expect(filterLicences(all, 'xyflow').map((p) => p.name)).toEqual(['@xyflow/react']);
  });

  it('matches the licence', () => {
    expect(filterLicences(all, 'bsd').map((p) => p.name)).toEqual(['qs']);
  });

  it('ignores case and surrounding spaces', () => {
    expect(filterLicences(all, '  MiT ').map((p) => p.name)).toEqual([
      '@xyflow/react',
      'type-fest',
    ]);
  });

  it('nothing matching gives an empty list', () => {
    expect(filterLicences(all, 'gpl')).toEqual([]);
  });
});
