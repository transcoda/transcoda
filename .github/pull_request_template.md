<!--
Thanks for contributing to Transcoda! A few notes before you start:

- For anything bigger than a small fix, please open an issue first so we can agree on the approach.
- Keep one change per pull request. Small, focused PRs get reviewed faster.
- Never include secrets, API keys, tokens, real media or personal file paths in code, tests, logs or screenshots.
-->

## What this changes

<!-- One or two sentences on what changes and why. Link the issue it closes, e.g. "Closes #123". -->

## Release note

<!--
What will a user notice? Add a file `.changes/<short-name>.md` to this pull request (format in `.changes/README.md`),
or tick the box below. CI checks that one of the two is there.
-->

- [ ] I added a release note in `.changes/`
- [ ] No user-facing change (refactor, tests, tooling, CI) — a maintainer adds the `no user-facing change` label

## Type of change

- [ ] Bug fix
- [ ] New feature or node
- [ ] Change to existing behaviour (describe what a user will notice)
- [ ] Docs only
- [ ] Refactor, tests or tooling (no behaviour change)

## How you tested it

<!--
What did you run, and what did you check by hand?
For anything that touches files on disk (transcodes, replacing originals, the recycle folder),
say which sample files you used and what happened to the originals.
-->

## Screenshots

<!-- For UI changes: before/after, light and dark theme, and a narrow (phone) width if layout changed. Delete if not relevant. -->

## Checklist

- [ ] `pnpm check` passes locally (typecheck, lint, dependency rules, tests)
- [ ] New behaviour has tests; bug fixes have a test that failed before the fix
- [ ] Nothing here can rewrite or delete media without the existing safety checks (verify, recycle folder, dry run)
- [ ] User-facing behaviour or settings changed → docs updated (`README.md`, `docs/`)
- [ ] Database changes come as a new numbered migration that keeps existing data
- [ ] UI changes work with keyboard and screen reader, and nothing relies on hover or colour alone
- [ ] No secrets, tokens or personal data in code, tests, logs or screenshots

By submitting this pull request, I confirm that my contribution is my own work and may be distributed under the project's license ([GPL-3.0](../LICENSE)).
