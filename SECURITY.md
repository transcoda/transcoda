# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: **Security → Report a vulnerability** on this repository (private vulnerability reporting). Do not open a public issue.

Useful to include: the Transcoda version (Settings → About), what an attacker can do, and steps to reproduce. You will get an answer within a few days.

## Supported versions

Fixes go into the newest release only: update to the latest `0.x` release to get them. Security fixes ship as a patch release as soon as they are ready (see [`docs/releasing.md`](docs/releasing.md)).

## Scope

In scope:

- The server, the web UI and the Docker image in this repository.
- Anything that lets someone without an account read or change data, run commands, or reach files outside the configured libraries.
- Anything that lets a workflow, plugin or API call delete or overwrite media without the safety checks (verify, recycle folder, dry run).
- The plugin sandbox, the catalog signature checks and the blocklist check.

The official plugins and the signed catalog live in [transcoda-plugins](https://github.com/transcoda/transcoda-plugins); report problems with them there (reports here are forwarded too).

Plugins are trusted code: the sandbox protects against accidents, not against a plugin written to do harm. What it does and doesn't do is in [`docs/plugin-sdk.md`](docs/plugin-sdk.md#what-the-sandbox-does-and-does-not-do).
