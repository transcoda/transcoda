# Settings forms

How Transcoda turns a settings schema into a form: the node inspector in the workflow editor, the setting rows on a node's card, and a plugin's integration settings on the Plugins page. For plugin authors who want to know what their `zod` schema will look like, and for anyone changing the forms. Where this page and the code disagree, the code wins and this page needs updating.

The code:

- `apps/web/src/editor/model/schema-fields.ts`: schema to fields, defaults, show-when, Advanced, the client's own checks.
- `apps/web/src/editor/ui/fields/`: one control per field kind, picked by `SettingField`; `Field.tsx` is the frame around each (label, default, Clear, message).
- `apps/web/src/editor/ui/NodeForm.tsx` (node settings) and `apps/web/src/plugins/PluginsPage/IntegrationSettings.tsx` (integration settings): the two forms.
- `apps/web/src/editor/model/setting-issues.ts`: which message a node's field shows.
- Server: `packages/sdk/src/node.ts` (`nodeMetadata`, `parseSettings`), `packages/sdk/src/integration.ts` (setting helpers, secret checks), `apps/server/src/nodes/plugin-settings-schema.ts`, `apps/server/src/workflows/validate/nodes.ts`, `apps/server/src/workflows/upgrade.ts`, `apps/server/src/plugins/settings.ts` and `crypto.ts`.

## From schema to fields

The browser never sees `zod`. The SDK publishes each settings schema as JSON Schema, `z.toJSONSchema(settings, { io: 'input' })` (zod 4), and `fieldsFor` reads that:

- **One field per top-level property**, in schema order. A schema that is not an object has no fields; the node form then shows one raw JSON box for the whole value.
- **Label, unit and hint come from `description`**, or from the key when there is none (`minSavingPercent` reads "Min saving percent"). The text up to the first `; ` or ` — ` (outside parentheses) is the label, the rest is the hint under the control. A trailing `(kbps)` is the unit; a trailing parenthetical that reads as a sentence (it holds `; ` or `: `) is a hint instead. `'Bitrate (kbps); unset keeps the source'` gives the label "Bitrate", the unit "kbps" and the hint "Unset keeps the source".
- **Required** means the key is in the object's `required` list. In `io: 'input'` mode a setting with a `.default()` or `.optional()` is not required.
- **The control** comes from `specFor`, a small fixed table (see "Supported shapes" below). The SDK's helpers set an `x-transcoda` marker that wins over the type: `secret()` is a password input, `url()` a URL input, `pathMappings()` the path-mapping rows, `allowInsecureTls()` a switch with its own help text. Core nodes also use `video-codecs` and `audio-codecs`.
- **Anything outside the table is raw JSON**: a textarea with the value as JSON. Text that does not parse says "Not valid JSON" and is not sent; empty text means "not set". Every setting stays editable, whatever its shape.

The server stays the authority on what is valid. The form only coerces typed text to the field's type and checks what JSON Schema says plainly: `required`, `minimum` and `maximum`, and `enum` (`clientIssue`).

## Defaults and "differs from default"

- **A new node gets its defaults stored.** Adding a node fills its settings with the top-level `default` of every property (`defaultSettings`, copied). So a node keeps the value it was created with, and changing a default in a later node version changes nothing for nodes that exist: do that with a migration (below).
- **An unset setting** (the key is not in the stored settings) means the schema default, which the server applies when it parses the settings. A field shows it in place: "Default: 24" or "Default: on" beside the label, the default as the input's placeholder, a switch or a choice set to it, a slider at it, muted and marked "default". A field with no plain default (none, `null`, a list, an object) reads "not set".
- **At default** means unset, or stored with a value equal to the default. Equality is deep and ignores object key order (`jsonEquals`). Such a field reads like an unset one, so a new node with its defaults filled in reads like an older one without them.
- **Clear** appears on an optional setting whose value is not its default. It removes the key, so the default applies again. A required setting has no Clear.
- **"N changed"** on a closed Advanced section counts its fields whose value differs from their default (`differsFromDefault`; an unset field never differs, and a stored `null` equals a `null` default).

## Basic and Advanced

Advanced is presentation only. The values, defaults and checks are the same; it only decides whether a field sits under a closed **Advanced** section after the others.

- **Core nodes:** the keys listed per node type in `ADVANCED_SETTINGS` (`isAdvancedSetting`), for example Encode video's encoder, preset and "never increase bitrate".
- **Integration settings:** the `pathMappings()` and `allowInsecureTls()` fields (`isAdvancedPluginSetting`, by their `x-transcoda` marker).
- **Plugin nodes:** every setting is shown; a plugin cannot mark a node setting as advanced yet.

Advanced opens by itself when a field inside it has a message, and in the node inspector when a field inside it is asked to be focused (from the issues list). Its "N changed" count is described above.

## Settings that show only for another setting's value

A property may carry `x-transcoda-show-when`, a map from another setting's key to a value: `{ rateControl: 'quality' }`. The field shows only while every named setting has that value (`fieldShown`), where an unset setting counts as its default. Values are compared with `===`, so they can be a string, a number or a boolean. Core's Encode video uses it to show the quality only in quality mode and the target bitrate only in bitrate mode. A plugin sets it with `.meta()`:

```ts
settings: z.object({
  notify: z.boolean().default(false),
  channel: z.string().optional().meta({ 'x-transcoda-show-when': { notify: true } }),
}),
```

It applies to the node inspector, to which setting a node's card shows (its first `onNodeSettings` key that is shown), and to the integration form. A hidden field keeps its stored value and is still sent and validated: the server and the engine do not read the marker, so a plugin that should ignore a setting in some mode must do so itself. A hidden field that has a message is shown anyway, so a problem never hides.

## Secrets and set-markers

Only integration settings hold secrets. `nodeMetadata` refuses a node whose settings contain a `format: 'password'` field, and `defineIntegration` requires every password field to use `secret()` and refuses a nullable one (optional is fine).

- **Stored encrypted.** On save, a non-empty string for a secret key is encrypted; the key absent or `{ set: true }` keeps the stored value; an empty string removes it (`sealSettings`). Only top-level keys can be secrets (`secretPaths`).
- **Read back as a set-marker.** `plugins.settingsGet` never returns a secret. A stored one comes back as `{ set: true }`, with `endsWith` (its last four characters) when the secret is token-like: at least 20 characters of letters, digits and `._~+/=-`. A passphrase or a short secret only reads as set.
- **The form shows it as stored.** A field holding a set-marker shows "Stored, ends in 4f2a" (or "Stored") and a Replace button, which swaps in an empty password input. It has no Clear and never says "not set".
- **Left out unless typed over.** The payload drops every set-marker (`payloadOf`), so the server keeps the stored secret. Emptying a replacement input goes back to the set-marker, not to "remove". A set-marker does not count as a change for "Save and test".
- **Test before save.** "Test connection" sends the form's values with stored secrets left out; the server fills them in from storage before the plugin's `test()` runs.

Core's webhook URLs work the same way inside a workflow: a read shows a notify node's URL as `scheme://host/…` (`isRedactedUrl`), the input starts empty with "Saved (…); type to replace", and saving the redacted form back keeps the stored URL.

## How a stored value survives a node migration

The form always renders the node type's current schema from the node catalogue, and it never runs a migration itself. What keeps stored values working:

- **The form keeps what it does not show.** An edit merges one key into the stored settings; keys the current schema has no field for, and fields hidden by show-when, keep their values. Only Clear removes a key.
- **Core nodes are migrated on the server.** A node type that changes its settings bumps `version` and adds a `migrations` step (`from`, `to`, `risk`, `note`, `migrate(settings)`). At server start `upgradeAll` runs each workflow's newest version through the chain (`planNodeUpgrades`) and writes the result as a new version; the active version is never touched. A restored old version is upgraded the same way. A step with `risk: 'behaviour'` makes that new version one a person must review and activate. If any node has no path, or a migration throws or produces an invalid graph, nothing in that workflow is migrated.
- **Plugin nodes are migrated in the plugin's process.** Migration code never runs in core. After an install, update, enable or server start, core asks the plugin host to `migrate` the plugin's nodes in each workflow's newest version, checks the result against the node's current schema (and at most 256 kB), and saves it as a new version. Until then a node pinned to an older version with an all-`safe` path still runs: core passes its settings as stored, and the host migrates and validates them on each call. See "Node versions and migrations" in [plugin-sdk.md](plugin-sdk.md).
- **Defaults are stored, so they are frozen.** Because a new node stores its defaults, a migration that wants existing nodes on a new default has to write it.

## How server issues map back to fields

**Node settings.** The editor validates the draft on the server 400 ms after the last change (`workflows.validate`). Core parses each node's settings with the node's `zod` schema (`parseSettings`); for a plugin node that is a loose copy of the plugin's JSON Schema (`serverSettingsSchema`) that drops `pattern` and `format` and caps strings at 64 KiB, and the plugin host checks the settings again with the plugin's own `zod` before every call. Each problem is an `INVALID_SETTINGS` issue with the setting's path as `settingPath` (`tags.1`, `server.port`), and "Needs a setting" when the value is missing.

- A field shows the message for its key, or else the first message whose path starts with its key: `tags.1` lands under Tags.
- The client's own check comes first. While the client has a message for a field, the server's messages for that field are replaced by it; a missing required value reads "Needs a setting" either way.
- A server message is shown only while the setting still holds the value the server checked. Edit the field and its old message goes away until the next answer (`effectiveNodeIssues`).
- A message without a path, or for a key the schema has no field for, shows at the top of the form.
- Choosing an issue in the issues list focuses its field by `settingPath`, falling back to the top-level key, and opens Advanced if the field is there.

**Integration settings.** "Save and test" first runs the client's check (required, bounds, enum) and sends nothing if it fails. The server then validates with the running plugin's own `zod`, or with the loose copy above when the plugin is not running, and answers `PLUGIN_SETTINGS_INVALID` with `{ path, message }` issues. Each message lands under the field of its path's first segment (the first message per field); one without a path shows under the form.

## Supported shapes

What each `zod` shape becomes. Shapes marked raw JSON still work: the value is edited as JSON, and the server's message shows under it.

| Shape | Control |
| --- | --- |
| `z.boolean()` | Switch |
| `z.number()`, `z.number().int()` | Number input; with both bounds at most 100 apart, also a slider |
| `z.enum([...])`, `z.union([z.literal('a'), z.literal('b')])` | Segmented choice up to 5 options, else a select |
| `z.string()` | Text input |
| `z.url()`, `url()` | URL input |
| `secret()` | Password input; a stored one shows as Stored with Replace |
| A language code (`LanguageCodeSchema` from `@transcoda/shared`) | Language picker |
| `z.array(z.string())` | Chips you type and remove |
| `z.array(LanguageCodeSchema)` | Language chips |
| `z.array(z.enum([...]))` | Toggle chips of the options |
| `pathMappings()` | Path mapping rows with a test button |
| `.optional()`, `.default(x)` on any of these | The same control, not required |
| `.nullable()` on any of these | The same control; give it `.default(null)` or `.optional()`, since the form clears a value by removing it and cannot store `null` |
| `z.object({...})` nested, optional or nullable | Raw JSON |
| `z.array(z.object({...}))` (other than `pathMappings()`) | Raw JSON |
| `z.array(z.number())` and other arrays | Raw JSON |
| A union of different types, a discriminated union, number literals | Raw JSON |

Keep settings flat where you can: a nested object is one raw JSON box, and its server messages show for the whole box rather than for the inner field.
