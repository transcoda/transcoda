// Webhook URLs may carry a token in their path or query, so the API treats them as write-only:
// every graph it returns (workflow detail, job detail) shows them as `scheme://host/…`, and a
// workflow save that sends a redacted value back unchanged keeps the stored one.
import type { SubworkflowSetting } from '@transcoda/contract';
import {
  type JsonValue,
  type NodeInstance,
  RUN_SUBWORKFLOW_TYPE,
  type WorkflowGraph,
} from '@transcoda/shared';
import { redactUrl } from '../engine/pipeline.ts';
import { isSecretOverride, NOTIFY_NODE } from '../workflows/webhook-urls.ts';

type JsonObject = { [key: string]: JsonValue };
const isObject = (v: JsonValue | undefined): v is JsonObject =>
  v !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v);

function redactOverrides(overrides: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(overrides).map(([key, value]) => [
      key,
      isSecretOverride(key, value) ? redactUrl(value) : value,
    ]),
  );
}

/**
 * The graph as the API shows it: a notify node's `url` and URL-valued Run-node overrides (see
 * {@link isSecretOverride}) show only their scheme and host.
 */
export function redactGraph(graph: WorkflowGraph): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const { settings } = n;
      if (!isObject(settings)) return n;
      if (n.type === NOTIFY_NODE && typeof settings.url === 'string') {
        return { ...n, settings: { ...settings, url: redactUrl(settings.url) } };
      }
      if (n.type === RUN_SUBWORKFLOW_TYPE && isObject(settings.overrides)) {
        return { ...n, settings: { ...settings, overrides: redactOverrides(settings.overrides) } };
      }
      return n;
    }),
  };
}

/** A sub-workflow's settings list with the notify nodes' `url` values redacted. */
export function redactSettings(
  settings: SubworkflowSetting[] | null,
  graph: WorkflowGraph,
): SubworkflowSetting[] | null {
  if (settings === null) return null;
  const notify = new Set(graph.nodes.filter((n) => n.type === NOTIFY_NODE).map((n) => n.id));
  return settings.map((s) =>
    notify.has(s.nodeId) && s.settingKey === 'url' && typeof s.default === 'string'
      ? { ...s, default: redactUrl(s.default) }
      : s,
  );
}

/** A value in the form {@link redactGraph} shows (`scheme://host/…`, or "an invalid URL"). */
const REDACTED_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*\/…$/i;
const REDACTED_INVALID_URL = 'an invalid URL';
export function isRedactedForm(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && (REDACTED_URL.test(value) || value === REDACTED_INVALID_URL);
}

/**
 * Undoes the redaction for a graph sent back to be saved. A notify `url` or a Run-node override
 * sent in its redacted form is the stored value whose redacted form it equals, taken from the
 * same node (id and type) and key in the first of `history` that has one: callers order it
 * restored-from version, base version, then the rest newest first, so a restore or a save over a
 * newer version finds the value the user saw. Anything not in redacted form is taken as sent (a
 * new URL replaces the old one). A redacted value that matches no version is never stored as a
 * literal: its node id is listed in `unresolved` and the save must be refused. `history` is only
 * read as far as a lookup needs.
 */
export function restoreRedacted(
  graph: WorkflowGraph,
  history: Iterable<WorkflowGraph>,
): { graph: WorkflowGraph; unresolved: string[] } {
  const unresolved = new Set<string>();
  // `history` is read once, lazily; what was read is kept for the next lookup.
  const source = history[Symbol.iterator]();
  const read: WorkflowGraph[] = [];
  function* graphs(): Generator<WorkflowGraph> {
    yield* read;
    for (let next = source.next(); !next.done; next = source.next()) {
      read.push(next.value);
      yield next.value;
    }
  }
  const lookup = (node: NodeInstance, pick: (settings: JsonObject) => JsonValue | undefined) => {
    for (const g of graphs()) {
      const old = g.nodes.find((o) => o.id === node.id && o.type === node.type);
      if (!old || !isObject(old.settings)) continue;
      const value = pick(old.settings);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const nodes = graph.nodes.map((n): NodeInstance => {
    const { settings } = n;
    if (!isObject(settings)) return n;
    if (n.type === NOTIFY_NODE && isRedactedForm(settings.url)) {
      const sent = settings.url;
      const url = lookup(n, (was) =>
        typeof was.url === 'string' && redactUrl(was.url) === sent ? was.url : undefined,
      );
      if (url === undefined) {
        unresolved.add(n.id);
        return n;
      }
      return { ...n, settings: { ...settings, url } };
    }
    if (n.type === RUN_SUBWORKFLOW_TYPE && isObject(settings.overrides)) {
      const overrides = Object.fromEntries(
        Object.entries(settings.overrides).map(([key, value]) => {
          if (!isRedactedForm(value)) return [key, value];
          const prior = lookup(n, (was) => {
            const p = isObject(was.overrides) ? was.overrides[key] : undefined;
            return isSecretOverride(key, p) && redactUrl(p) === value ? p : undefined;
          });
          if (prior === undefined) unresolved.add(n.id);
          return [key, prior ?? value];
        }),
      );
      return { ...n, settings: { ...settings, overrides } };
    }
    return n;
  });
  return { graph: { ...graph, nodes }, unresolved: [...unresolved] };
}
