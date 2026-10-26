// Webhook URLs may carry a token in their path or query. These helpers decide which values count
// as webhook URLs (shared by redaction and duplication) and strip them from a graph.
import {
  type JsonValue,
  type NodeInstance,
  RUN_SUBWORKFLOW_TYPE,
  type WorkflowGraph,
} from '@transcoda/shared';
import { splitOverrideKey } from './subworkflow-settings.ts';

export const NOTIFY_NODE = 'core:notify-webhook';

type JsonObject = { [key: string]: JsonValue };
const isObject = (v: JsonValue | undefined): v is JsonObject =>
  v !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v);

export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Whether a Run-node override is shown redacted. Deliberately broad (conservative): an override of
 * any `url` setting, and any string that parses as an http(s) URL, whatever the setting is — the
 * sub-workflow's node types are not looked up, so e.g. a media-server base URL is redacted too.
 */
export function isSecretOverride(key: string, value: JsonValue | undefined): value is string {
  return (
    typeof value === 'string' && (splitOverrideKey(key)?.settingKey === 'url' || isHttpUrl(value))
  );
}

/**
 * The graph with every webhook URL removed: a notify node's `url` becomes '', URL-valued Run-node
 * overrides are deleted. `droppedNodeIds` lists, once each and in graph order, every notify node
 * whose `url` was a non-empty string and every Run node that lost at least one override.
 */
export function dropWebhookUrls(graph: WorkflowGraph): {
  graph: WorkflowGraph;
  droppedNodeIds: string[];
} {
  const droppedNodeIds: string[] = [];
  const nodes = graph.nodes.map((n): NodeInstance => {
    const { settings } = n;
    if (!isObject(settings)) return n;
    if (n.type === NOTIFY_NODE && typeof settings.url === 'string') {
      if (settings.url === '') return n;
      droppedNodeIds.push(n.id);
      return { ...n, settings: { ...settings, url: '' } };
    }
    if (n.type === RUN_SUBWORKFLOW_TYPE && isObject(settings.overrides)) {
      const kept = Object.entries(settings.overrides).filter(
        ([key, value]) => !isSecretOverride(key, value),
      );
      if (kept.length === Object.keys(settings.overrides).length) return n;
      droppedNodeIds.push(n.id);
      return { ...n, settings: { ...settings, overrides: Object.fromEntries(kept) } };
    }
    return n;
  });
  return { graph: { ...graph, nodes }, droppedNodeIds };
}
