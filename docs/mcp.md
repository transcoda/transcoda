# MCP server

Transcoda has a built-in [Model Context Protocol](https://modelcontextprotocol.io) server. An agent such as Claude Code or Claude Desktop can use it to look into jobs, read and change workflows and start dry runs, with the same permissions the REST API gives the same token.

## What it is

- The endpoint is `/mcp` on the same port as the UI: `http://<host>:8080/mcp`.
- It speaks MCP Streamable HTTP in stateless mode with JSON responses: every request is a POST that carries its own bearer token, no session id is ever issued, and nothing is kept between requests. A token that is revoked or expires stops working on the next call.
- It is built in. There is nothing to install or enable on the server; it works with any MCP client that can send a bearer header.
- Only API tokens (`Authorization: Bearer tcd_…`) are accepted. A browser session cookie alone gets a 401, and when both are sent the cookie is ignored. OAuth is not offered.

## What an agent can and cannot do

An agent can, depending on the scopes of its token:

- diagnose jobs: list them, read a job's report and log tail, and see the queue status;
- read workflows, their versions and the node catalogue, and validate a graph;
- see which plugins are installed and whether they run;
- create, change, duplicate, rename and delete workflows;
- start dry runs (plans) on a file or folder in a library, optionally test-encoding (`testEncode`: encode, verify and measure for real, still writing nothing to the library);
- with `jobs:manage`, pause, resume and cancel jobs (one or all) and pause or resume the queue.

An agent can never, whatever its scopes:

- activate or deactivate a workflow version (what runs for real);
- queue a real (non-dry) run;
- play, download or delete a test output (the kept output of a test-encode dry run; only a person's browser session can, on the job page);
- read a webhook URL (graphs show only `scheme://host/…`);
- change libraries or tokens;
- install, update or remove plugins, enable or disable them, read or change integration settings, or read a trigger secret (a person does that on the Plugins page; the API refuses any token for it);
- read or change server settings, or change a password (a person does that under Settings; the API refuses any token for a change).

Every change an agent makes is a normal workflow version in the workflow's history. The note reads `via MCP`, or `via MCP: <note>` when the agent gave one. A save never changes what runs; activating a workflow version is human-only, in the UI.

## Create a token

Open the UI, go to **Settings → API tokens** (`/settings/api-tokens`) and create a token. The token is shown once; copy it then. Scopes unlock tools as follows:

| Use | Scopes | Unlocks |
| --- | --- | --- |
| Diagnose | `read` | all read tools |
| Edit and try | `read`, `workflows:write`, `plan` | the above, plus creating and changing workflows and `dry_run` |
| Operate | `read`, `workflows:write`, `plan`, `jobs:manage` | the above, plus pausing, resuming and cancelling jobs and the queue |

Scopes are exact and do not imply each other: a token that writes workflows also needs `read` to list or open them. `jobs:create` is accepted for `dry_run` but gives nothing more over MCP. A tool the token's scopes do not allow is absent from the tool list. Revoke a token on the same page.

## Claude Code

```sh
claude mcp add --transport http transcoda http://localhost:8080/mcp --header "Authorization: Bearer tcd_…"
claude mcp list        # transcoda: … - ✓ Connected
```

In a session, `/mcp` shows `transcoda` with its tools. Add `--scope user` to keep it across projects; `claude mcp remove transcoda` drops it. Replace `localhost:8080` with the host the UI is reached by; it must pass the host check (the host recorded at setup, `TRANSCODA_ALLOWED_HOSTS`, or localhost).

## Claude Desktop

Edit `claude_desktop_config.json` (macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`; or Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "transcoda": {
      "command": "npx",
      "args": ["-y", "mcp-remote@0.14.3", "http://localhost:8080/mcp", "--header", "Authorization:${TRANSCODA_AUTH}"],
      "env": { "TRANSCODA_AUTH": "Bearer tcd_…" }
    }
  }
}
```

Notes:

- `Authorization:${TRANSCODA_AUTH}` has no space after the colon. This is mcp-remote's documented workaround for clients that mangle spaces in arguments (Cursor, Codex CLI and Claude Desktop on Windows); macOS works with either form, but this one is safe everywhere; the space is inside the variable.
- To keep the token out of the process list, use `"--header-file", "/path/headers.txt"` instead of `--header`, with one line in the file: `Authorization: Bearer tcd_…`.
- Node 18 or newer must be on the `PATH` of Claude Desktop.
- Restart Claude Desktop after editing the file.

Nothing changes on the Transcoda side for this.

## Behind a reverse proxy / HTTPS

The same rules as for the API apply: set `TRANSCODA_TRUSTED_PROXIES` for your proxy, make the public host name pass the host check (`TRANSCODA_ALLOWED_HOSTS`), and use the public URL (for example `https://transcoda.example.com/mcp`) in the client. See [`env.md`](env.md).

## Tools

26 tools. A token sees only the tools its scopes allow.

| Tool | Scope | What it does |
| --- | --- | --- |
| `queue_status` | `read` | Whether the queue is paused, the jobs in each lane, jobs being prepared, and the number of jobs per state. |
| `pause_queue` | `jobs:manage` | Pause the queue: running jobs freeze and nothing new starts. |
| `resume_queue` | `jobs:manage` | Resume the queue. |
| `list_jobs` | `read` | List jobs, filtered by state, library or run; 20 per page (max 200), with `nextCursor` for `before`. |
| `get_job` | `read` | A job's diagnosis: state, reason, the failing node (only when a node recorded the failure; an ffmpeg failure names no node), the path the file took, per-node decisions, result and plan. |
| `get_job_log` | `read` | The tail of a job's log (`maxBytes` 256 to 65536, default 16384); empty if the job has not started. |
| `pause_job` | `jobs:manage` | Pause a queued or running job; a running ffmpeg is stopped and its lane freed. |
| `resume_job` | `jobs:manage` | Resume a paused job. |
| `cancel_job` | `jobs:manage` | Cancel a job that has not finished. |
| `cancel_all_jobs` | `jobs:manage` | Cancel every job that has not finished (queued, running or paused), optionally of one library (`libraryId`). Running ffmpeg processes are stopped and their partial output removed. A job already replacing its file finishes. Returns `cancelled`, `writing` (left to finish) and `failed` (could not be cancelled, still running). |
| `list_workflows` | `read` | List workflows with their kind, active and current version, and `feedsLibrary`: the library the active version's Library input takes files from, or null. |
| `get_workflow` | `read` | One workflow with its graph (webhook URLs redacted), optionally at a version. |
| `list_workflow_versions` | `read` | A workflow's version history with notes. |
| `list_nodes` | `read` | The node catalogue; with `type`, one node with its settings schema. A full node carries `finishPhase` (null for a finish node that declares none). |
| `validate_workflow` | `read` | Check a graph without saving it; returns `valid` and the issues. |
| `create_workflow` | `workflows:write` | Create a workflow (optionally with a graph); it starts with no active version (dry runs only). |
| `save_workflow` | `workflows:write` | Save a new version from `baseVersion`; a stale base is refused. A save never changes what runs; activating is human-only in the UI. |
| `duplicate_workflow` | `workflows:write` | Copy a workflow under a new name. Webhook URLs are dropped and the affected node ids reported. |
| `rename_workflow` | `workflows:write` | Rename a workflow. |
| `delete_workflow` | `workflows:write` | Delete a workflow; a sub-workflow that other workflows use is refused (`IN_USE`). |
| `list_plugins` | `read` | The installed plugins with version, state (and why one does not run), node types and any update on offer. Never settings. |
| `list_libraries` | `read` | Libraries with id, name, root path, recycle folder and `feeds`: the active workflow that takes files from the library through its Library input (`workflowId`, `name`, `version`), or null. |
| `browse_library` | `read` | Folders and files under a library path; every returned path can be given to `dry_run`. |
| `list_runs` | `read` | Recent runs (20 by default, max 200). |
| `get_run` | `read` | One run with its files and per-file outcome. |
| `dry_run` | `plan` or `jobs:create` | Queue a dry run (a plan) for a file or folder in a library; never changes a file. Poll `get_job` until its state is final (`done`, `failed`, `cancelled`, `skipped`, `nothing_to_do`, `kept_original`, `dry_run`, `already_processed`); a dry run usually ends `dry_run` or `nothing_to_do`. Without `workflowId` the workflow that feeds the library (the active workflow whose Library input names it) is used. The newest saved version is used unless `version` says otherwise. `testEncode` (default `false`) also encodes, verifies and measures each file for real and lets the size gates decide on the measured size; it is slow, queues in the encode lane behind real jobs, and still writes nothing to the library. A test-encode dry run ends `dry_run` (would replace) or `kept_original` (would keep the original), and `get_job` reports the measured `afterBytes` (`[test encode]`, `measured … bytes`) instead of an estimate. A plan-only dry run whose path writes with a size gate between the encode and the write cannot know the gate's answer: it ends `dry_run` with `dependsOnSize: { minSavingPercent }` (`get_job`/`list_jobs`: `would replace if it saves ≥ N% (decided after encoding)`), and `list_runs`/`get_run` count `would replace`, `depend on size` and `nothing to do` apart; a `testEncode` dry run measures it instead. |

## Errors

A failed call is a tool result, not a protocol error: `isError: true` and one text block, `CODE: message`, then a hint where one helps and a `Details: {…}` line with the error's data (`currentVersion`, `nodeIds`, `usedBy`, `path`/`reason`). There is deliberately no `structuredContent` on a failure: SDK clients (Claude Code included) validate it against the tool's output schema even when `isError` is set and would turn the failure into a -32602 error. Codes an agent meets:

| Code | Meaning |
| --- | --- |
| `NOT_FOUND` | The job, workflow (or the version asked for), library or run does not exist. |
| `VERSION_CONFLICT` | `baseVersion` is stale; `currentVersion` says which to use. Read the workflow and save again. |
| `KIND_MISMATCH` | The graph's kind (workflow or sub-workflow) differs from the kind of the workflow it is saved to or created as. |
| `HIDDEN_URL_UNKNOWN` | A redacted webhook URL could not be matched to a stored one; `nodeIds` lists the nodes that need a full URL entered by a person. |
| `IN_USE` | The sub-workflow is used by other workflows, so it cannot be deleted; `usedBy` lists them. |
| `WORKFLOW_INVALID` | The workflow version a dry run would use has errors; `issues` lists why. (`save_workflow` stores an invalid graph and reports its issues instead.) |
| `PATH_REJECTED` | The path is outside the library or otherwise refused; `data.reason` says why. |
| `JOB_NOT_ACTIVE` | The job is not in a state that allows this: it has already finished (pause, cancel) or is not paused (resume). |
| `NO_FEEDING_WORKFLOW` | `dry_run` was given no `workflowId` and no active workflow takes files from the library. |
| `BAD_REQUEST` | The API rejected the arguments. Most bad arguments are caught earlier as `Input validation error: …`. |
| `INTERNAL` | Something unexpected failed; the message is generic and the server log has the detail. |

A tool the token may not use is absent from the list; calling it anyway answers an `isError` result with the text `MCP error -32602: Tool <name> not found`. Arguments that fail a tool's input schema answer `Input validation error: …` the same way. `dry_run` has a strict input: an unknown argument (`workflowVersion`, `dryRun`, `mode`) is refused with that error, naming the key, instead of being dropped. Use `version`; `dry_run` never runs for real.

## Checking the connection

```sh
T=tcd_…; U=http://localhost:8080/mcp
curl -s $U -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# → {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"transcoda","version":"…"},…}}
curl -s $U -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq -r '.result.tools[].name'
curl -s $U -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"queue_status","arguments":{}}}' | jq '.result.structuredContent'
```

HTTP-level refusals:

- 401 `Authentication required: send Authorization: Bearer <API token>`: no bearer header, or the token is unknown, revoked or expired. A session cookie does not count.
- 403 `Host not allowed`: the `Host` header is not the setup host, in `TRANSCODA_ALLOWED_HOSTS`, or localhost.
- 403 `Origin not allowed`: the request carries an `Origin` that does not match an allowed host.
- 405: `/mcp` accepts POST only (no GET stream, no session delete).

## Limits

- Request bodies are limited to 2 MiB (413 above that).
- `get_job_log` returns at most 64 KiB, the API's tail.
- `list_jobs` and `list_runs` return at most 200 per page.
- There are no sessions and no resumable streams.
- There is no rate limit beyond the API's. A token is as powerful as its scopes; revoke it on the tokens page.
