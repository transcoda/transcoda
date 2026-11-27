# Agent instructions

For coding agents working in this repository. Everything in [CONTRIBUTING.md](CONTRIBUTING.md) applies; this file adds the rules that agents tend to skip.

## UI changes

- A UI fix or change counts as done only with **before and after screenshots** of the affected page, at the widths and in the themes it touches. Put both in the pull request.
- Run the browser tests (`pnpm build && pnpm fixtures && pnpm e2e`) when a change touches a flow they cover.
- Follow [DESIGN.md](DESIGN.md) for colours, type, spacing and icons.

## Tests

Which tier a test belongs in: [docs/decisions.md](docs/decisions.md), "Test tiers". Run `pnpm check` before opening a pull request.
