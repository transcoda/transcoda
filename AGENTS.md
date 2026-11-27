# Agent instructions

For coding agents working in this repository. Everything in [CONTRIBUTING.md](CONTRIBUTING.md) applies; this file adds the rules that agents tend to skip.

## UI changes

- A UI fix or change counts as done only with **before and after screenshots** of the affected page, at the widths and in the themes it touches. Put both in the pull request.
- Run the browser tests (`pnpm e2e:docker`) when a change touches a page or a flow they cover. When a page changes on purpose, update its screenshot baselines with `pnpm e2e:update`, look at every changed image, and commit them in the same pull request.
- Follow [DESIGN.md](DESIGN.md) for colours, type, spacing and icons.

## Tests

Which tier a test belongs in: [docs/decisions.md](docs/decisions.md), "Test tiers". Run `pnpm check` before opening a pull request.
