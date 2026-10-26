import type { Issue, JsonValue } from '@transcoda/shared';
import { NEEDS_A_SETTING } from './issues.ts';
import { clientIssue, type FieldDef } from './schema-fields.ts';

type JsonObject = { [key: string]: JsonValue };

function isObject(v: JsonValue | undefined): v is JsonObject {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
}

/** Deep equality of two JSON values (object key order ignored). */
export function jsonEquals(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => jsonEquals(v, b[i]))
    );
  }
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && jsonEquals(a[k], b[k]))
  );
}

/** "languages.1" → "languages". */
export const topLevelKey = (path: string): string => path.split('.')[0] ?? path;

const isSettingsIssue = (i: Issue) => i.code === 'INVALID_SETTINGS';

/**
 * A node's issues as the inspector judges its settings: the client's check first, the server's
 * message only where the client has none and only while the setting still holds the value the
 * server validated (`validated`, the node's settings in `EditorState.issuesGraph`).
 *
 * - A server `INVALID_SETTINGS` for a field whose value changed since validation is dropped
 *   (stale); a path-less one is dropped when any setting changed.
 * - A field with a client issue (`clientIssue`: required, bounds, enum) replaces the server's
 *   messages for it with one `INVALID_SETTINGS`; a missing required value is "Needs a setting",
 *   so the amber "needs a setting" state follows the form, not the last response.
 * - Without fields (unknown node, settings not an object, Run node) the server's issues stay.
 */
export function effectiveNodeIssues(
  nodeId: string,
  fields: FieldDef[] | null,
  settings: JsonValue,
  validated: JsonValue | undefined,
  issues: Issue[],
): Issue[] {
  const own = issues.filter((i) => i.nodeId === nodeId);
  if (!fields || !isObject(settings)) return own;
  const before = isObject(validated) ? validated : undefined;
  const keys = new Set(fields.map((f) => f.key));

  const client = new Map<string, Issue>();
  for (const field of fields) {
    const value = settings[field.key];
    const message = clientIssue(field, value);
    if (message === null) continue;
    client.set(field.key, {
      severity: 'error',
      code: 'INVALID_SETTINGS',
      message: value === undefined && field.required ? NEEDS_A_SETTING : message,
      nodeId,
      settingPath: field.key,
    });
  }

  // Server order is kept (the state line ranks ties by it, as the card does): a client issue
  // takes the place of the server's first message for its setting; new ones come last.
  const out: Issue[] = [];
  const placed = new Set<string>();
  for (const i of own) {
    if (!isSettingsIssue(i)) out.push(i);
    else if (i.settingPath === undefined) {
      if (jsonEquals(settings, before)) out.push(i);
    } else {
      const key = topLevelKey(i.settingPath);
      const mine = client.get(key);
      if (!keys.has(key)) out.push(i);
      else if (mine) {
        if (!placed.has(key)) out.push(mine);
        placed.add(key);
      } else if (before !== undefined && jsonEquals(settings[key], before[key])) out.push(i);
    }
  }
  for (const [key, issue] of client) if (!placed.has(key)) out.push(issue);
  return out;
}
