# Release notes

Every pull request that changes something a user can notice adds one small file here. At release time these files become the changelog on GitHub and the "What's new" list inside Transcoda, then they are removed.

## Format

Name the file after the change, for example `.changes/keep-original-language.md`:

```markdown
---
type: improved
---
Keep languages can now keep the file's original language even when it isn't in your list.
```

- `type` is one of `new`, `improved`, `fixed`, `breaking`.
- Write one or two sentences for people who use Transcoda, not for developers: what they will notice and, if it matters, what they need to do. No code, commit hashes or internal names.
- For `breaking`, say what a user has to change after updating.

A pull request with no user-facing change (refactor, tests, tooling, CI) needs no file; a maintainer adds the `no user-facing change` label instead.

## Cutting a release

The full steps (release branch, pull request, tag) are in [`docs/releasing.md`](../docs/releasing.md). The command at their heart:

```sh
pnpm release 0.2.0 --dry-run   # preview, changes nothing
pnpm release 0.2.0             # cut the release
```

Options: `--date YYYY-MM-DD` (default: today). The version must be valid semver, newer than the version in `package.json`, and not already in `apps/server/src/changelog.json`.

It reads every note in `.changes/` (except this README), checks them with the same rules as the pull request check, and groups them as Breaking, New, Improved, Fixed. Then it:

- adds a `## <version> — <date>` section at the top of `CHANGELOG.md` (created if missing),
- writes `release-notes.md` (git-ignored), the release body for this version only,
- adds the version to the top of `apps/server/src/changelog.json` (newest first, past versions are kept), which the server bundles for the "What's new" list,
- sets the version in `package.json`, `apps/server`, `apps/web`, `packages/shared` and `packages/contract` (the server shows it under Settings → About; the plugin SDK keeps its own version),
- deletes the consumed notes.

It stops with an error, without changing anything, if there are no notes, the version is invalid, not newer or already released, or a note is invalid. Review the changes, then commit them.
