# Releasing Transcoda

How Transcoda gets version numbers, when releases happen and how a maintainer cuts one.

## Version numbers

Transcoda uses [semantic versioning](https://semver.org): `MAJOR.MINOR.PATCH`. The first release is `0.1.0`.

While the version starts with `0.`:

- **Minor** (`0.2.0`, `0.3.0`): new features, and any change you might have to act on. Every change that needs action from you is listed under **Breaking** in the release notes, with what to do.
- **Patch** (`0.2.1`): fixes only. A patch release never needs action from you.

`1.0.0` comes once the workflow format, the REST API and the plugin API are stable enough to promise that a minor release never breaks them. From then on, breaking changes only come in a new major version.

The plugin SDK (`packages/sdk`) and each official plugin in [transcoda-plugins](https://github.com/transcoda/transcoda-plugins) have their own version numbers.

## Docker image tags

| Tag | What it is |
| --- | --- |
| `latest` | The newest release. |
| `0.2` | The newest `0.2.x` release: fixes arrive, features don't. |
| `0.2.1` | Exactly that release. Never changes. |
| `main` | The newest build of the main branch. Unreleased; for testing. |

A pre-release tag (`v0.3.0-rc.1`) publishes only its own version tag, never `latest` or `0.3`.

## Schedule

- **A minor release every four weeks**, from whatever is merged and ready. A feature that isn't ready waits for the next one; a release doesn't wait for a feature.
- **Patch releases when a fix matters**: a bug that loses data or stops jobs, a broken upgrade, a regression. No fixed date.
- **Security fixes as soon as they are ready**, as a patch release (see [SECURITY.md](../SECURITY.md)).

## Milestones

Each upcoming minor release has a GitHub milestone named after its version (`0.2.0`) with its planned date. Issues and pull requests meant for that release go into it, so the milestone shows what is left. At release time, anything still open moves to the next milestone. Patch releases don't get a milestone.

## Cutting a release

You need maintainer rights. Every step except the tag runs through a normal pull request.

1. **Check the milestone.** Move anything still open to the next milestone.
2. **Make the release branch** from an up-to-date `main`:

   ```sh
   git switch -c release/0.2.0 origin/main
   pnpm release 0.2.0 --dry-run   # preview, changes nothing
   pnpm release 0.2.0
   ```

   This turns the notes in `.changes/` into a `CHANGELOG.md` section and the in-app "What's new" list (`apps/server/src/changelog.json`), deletes the notes, and sets the version in the app's `package.json` files. It refuses a version that isn't newer than the current one. Details in [`.changes/README.md`](../.changes/README.md).

3. **Open the release pull request** titled `release: 0.2.0`, with the `no user-facing change` label (the notes it removes are the release). Check `CHANGELOG.md` reads well, then squash-merge it.
4. **Tag the merge commit** on `main` and push the tag:

   ```sh
   git fetch origin
   git tag -a v0.2.0 -m "Transcoda 0.2.0" origin/main
   git push origin v0.2.0
   ```

5. **Watch the workflows.** `release.yml` checks that the tag matches the version in `apps/server/package.json` and is on `main` (or a `release/*` branch), then publishes the GitHub Release with the `CHANGELOG.md` section. `docker.yml` builds and pushes the image tags above for amd64 and arm64.
6. **Close the milestone** and create the next one, four weeks out.

A patch release is the same, from `main`. If `main` already has features meant for the next minor release, branch the patch from the last release tag instead (`git switch -c release/0.2.1 v0.2.0`), cherry-pick the fixes, run `pnpm release 0.2.1`, push the branch and tag its head (keep the branch: the release check looks for it). Then copy the new `CHANGELOG.md` section and `changelog.json` entry to `main` in a pull request.

## Releasing the plugin SDK

`@transcoda/sdk` is published to npm on its own version (`packages/sdk/package.json`), independent of the app. Follow its compatibility rules in [`packages/sdk/README.md`](../packages/sdk/README.md): additive changes are a minor, a changed hook signature or context field is a major.

1. **Bump the version** in `packages/sdk/package.json` (and the version named in `packages/sdk/README.md` and `docs/plugin-sdk.md`) in a pull request, and merge it.
2. **Tag the merge commit** on `main` and push the tag:

   ```sh
   git fetch origin
   git tag -a sdk-v1.1.0 -m "@transcoda/sdk 1.1.0" origin/main
   git push origin sdk-v1.1.0
   ```

3. **Approve the run.** `sdk-publish.yml` waits for approval in the `npm` environment, then checks that the tag matches the package version and is on `main`, runs the type check and the SDK tests, builds the package (`@transcoda/shared` is inlined, `zod` stays a dependency) and publishes it with provenance. It needs no npm token: npm trusts this workflow through trusted publishing (configured on npmjs.com for the `@transcoda/sdk` package: repository `transcoda/transcoda`, workflow `sdk-publish.yml`, environment `npm`).

To check the package before a release: `pnpm --filter @transcoda/sdk build && pnpm --filter @transcoda/sdk pack`.

Release tags are protected: once pushed, a tag can't be moved or deleted. If a release is broken, cut the next patch version; never re-tag.
