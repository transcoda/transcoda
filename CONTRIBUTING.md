# Contributing to Transcoda

Thanks for helping. Bug reports, ideas, docs fixes and code are all welcome.

## Before you start

- **Found a bug?** [Open an issue](https://github.com/transcoda/transcoda/issues/new/choose) with the bug template. Say what you did, what happened and what you expected. Logs help; take out secrets and file paths you don't want public first.
- **Have an idea?** Open an issue with the feature template before writing code, so we can agree on the approach. Small fixes (typos, an obvious bug) can go straight to a pull request.
- **Found a security problem?** Don't open an issue. Follow [SECURITY.md](SECURITY.md).
- **Want to write a plugin?** Plugins live in their own repository: [transcoda-plugins](https://github.com/transcoda/transcoda-plugins). The SDK is described in [`docs/plugin-sdk.md`](docs/plugin-sdk.md).

Issues labelled [`good first issue`](https://github.com/transcoda/transcoda/labels/good%20first%20issue) are a good place to start.

## Setting up

You need Node 24 (see `.node-version`), pnpm (`corepack enable`) and ffmpeg (`brew install ffmpeg` on a Mac).

```sh
git clone https://github.com/<you>/transcoda.git
cd transcoda
corepack enable
pnpm install
pnpm fixtures                          # small test videos, made with ffmpeg
pnpm --filter @transcoda/server dev    # API on :8080
pnpm --filter @transcoda/web dev       # UI with hot reload on http://localhost:5173
pnpm check                             # typecheck, lint, dependency and licence rules, tests
```

More in the README's [Development](README.md#development) section.

## Making a pull request

1. Fork the repository and create a branch from `main`.
2. Keep it to one change. Small pull requests get reviewed faster.
3. Add tests. A bug fix comes with a test that failed before the fix.
4. Run `pnpm check` and make sure it passes.
5. Add a release note: a small file in `.changes/` that tells users what they will notice ([format](.changes/README.md)). A change users won't notice (refactor, tests, tooling) needs none; say so in the pull request and a maintainer adds the `no user-facing change` label.
6. Open the pull request and fill in the template.

Never put secrets, API keys, real media or personal file paths in code, tests, logs or screenshots.

## How pull requests get merged

- CI must pass: `pnpm check`, the build, and the release-note check.
- A maintainer reviews it. Every pull request from a contributor needs a maintainer's approval before it can be merged.
- A maintainer merges it with **squash merge**: your branch becomes one commit on `main`, and the pull request title becomes the commit message. A title like `fix(engine): a stopped job keeps its partial output` helps.
- If the pull request is meant for a particular release, a maintainer puts it in that release's milestone.

After merging, your change ships in the next release. How releases work: [`docs/releasing.md`](docs/releasing.md).

## Code of conduct

Be kind and assume good intent. Keep discussion about the work. Harassment or personal attacks get you removed from the project.

## License

Transcoda is licensed under the [GNU General Public License v3.0](LICENSE). By opening a pull request you confirm that the contribution is your own work and may be distributed under that license.
