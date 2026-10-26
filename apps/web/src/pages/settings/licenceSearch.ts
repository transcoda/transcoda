import type { ThirdPartyPackage } from '@transcoda/contract';

/** The packages whose name or licence contains `query` (case-insensitive); a blank query keeps all. */
export function filterLicences(pkgs: ThirdPartyPackage[], query: string): ThirdPartyPackage[] {
  const q = query.trim().toLowerCase();
  if (q === '') return pkgs;
  return pkgs.filter(
    (p) => p.name.toLowerCase().includes(q) || p.licence.toLowerCase().includes(q),
  );
}
