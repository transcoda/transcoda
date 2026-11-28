/**
 * The version a build reports (baked into the server by tsdown as `TRANSCODA_VERSION`, into the web
 * app by Vite as `__TRANSCODA_VERSION__`). A release build is the
 * package version; any other build (main, a branch, a local build) is `<version>-dev`, with the
 * short commit as build metadata when known, so it is never mistaken for the release. Being a
 * pre-release version, it also never checks GitHub for updates (see `AppUpdateChecker`).
 */
export function buildVersion(
  pkgVersion: string,
  build: { release: boolean; commit: string | null },
): string {
  if (build.release) return pkgVersion;
  const commit = build.commit?.trim() ?? '';
  return /^[0-9a-f]{7,40}$/i.test(commit)
    ? `${pkgVersion}-dev+${commit.slice(0, 7).toLowerCase()}`
    : `${pkgVersion}-dev`;
}
