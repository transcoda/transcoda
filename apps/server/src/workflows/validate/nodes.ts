import {
  type AnyNodeDefinition,
  isPortRequired,
  parseSettings,
  type SettingsParseResult,
} from '@transcoda/sdk';
import {
  type Edge,
  type Issue,
  type JsonValue,
  type NodeInstance,
  portShown,
  type WorkflowGraph,
} from '@transcoda/shared';
import { isRemoteDefinition } from '../../nodes/remote.ts';
import { migrationPath } from '../upgrade.ts';
import { defOf, error, title } from './issues.ts';
import { checkSharedOutputs, hiddenPortText } from './outputs.ts';
import type { NodeState, ValidationContext } from './types.ts';

// Checks 1 to 3: each node's type, version and settings, then the edges and inputs.

export const behaviourHoldText = (nodeTitle: string): string =>
  `plugin update changes behavior of ${nodeTitle}; review and activate a new version`;

/** The message for a node whose stored version is not this server's, or null when current. */
function versionProblem(
  n: NodeInstance,
  def: AnyNodeDefinition,
  plugin: string | null,
): string | null {
  if (n.typeVersion > def.version) {
    return `${title(n, def)} is at version ${n.typeVersion}, newer than this server's version ${def.version}`;
  }
  if (n.typeVersion < def.version) {
    if (isRemoteDefinition(def)) {
      // With a path the plugin host migrates the settings when the node runs: not a problem.
      const steps = migrationPath(def, n.typeVersion);
      if (steps !== null) {
        // A behaviour step is never run unreviewed: held like a core node, a person activates a
        // new version (the one the update wrote). Only safe-only paths migrate in the host.
        return steps.some((st) => st.risk !== 'safe') ? behaviourHoldText(title(n, def)) : null;
      }
      return `${title(n, def)} is at version ${n.typeVersion}; plugin ${plugin ?? def.type.split(':')[0]} no longer serves it (no upgrade path)`;
    }
    const noPath = migrationPath(def, n.typeVersion) === null ? ', and no upgrade path exists' : '';
    return `${title(n, def)} is at version ${n.typeVersion}; this server has version ${def.version}${noPath}`;
  }
  return null;
}

function safeParseSettings(def: AnyNodeDefinition, settings: JsonValue): SettingsParseResult {
  try {
    return parseSettings(def, settings);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      issues: [{ path: '', message: `Settings could not be checked: ${message}`, missing: false }],
    };
  }
}

/** Checks 1 and 2: node type/version and settings. */
export function checkNodes(
  graph: WorkflowGraph,
  ctx: ValidationContext,
  issues: Issue[],
): Map<string, NodeState> {
  const states = new Map<string, NodeState>();
  for (const n of graph.nodes) {
    const def = ctx.registry.get(n.type)?.def;
    if (!def) {
      states.set(n.id, { status: 'unknown' });
      issues.push(error('UNKNOWN_NODE_TYPE', `Unknown node type ${n.type}`, { nodeId: n.id }));
      continue;
    }
    const entry = ctx.registry.get(n.type);
    const problem = versionProblem(
      n,
      def,
      entry?.source.kind === 'plugin' ? entry.source.name : null,
    );
    if (problem) {
      const newer = n.typeVersion > def.version;
      states.set(n.id, { status: newer ? 'newer' : 'outdated', def });
      issues.push(
        error(newer ? 'UNKNOWN_NODE_VERSION' : 'NODE_OUTDATED', problem, { nodeId: n.id }),
      );
      continue;
    }
    if (isRemoteDefinition(def) && n.typeVersion < def.version) {
      // (reached only for a safe-only path: `versionProblem` reports the rest.) Pinned to an older plugin node version with a path: core does not parse these settings
      // (the schema is the new version's); the host validates them after migrating.
      const raw = n.settings;
      states.set(n.id, {
        status: 'current',
        def,
        settings: typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : null,
      });
      continue;
    }
    const parsed = safeParseSettings(def, n.settings);
    states.set(n.id, { status: 'current', def, settings: parsed.ok ? parsed.value : null });
    if (!parsed.ok) {
      for (const issue of parsed.issues) {
        issues.push(
          error('INVALID_SETTINGS', issue.missing ? 'Needs a setting' : issue.message, {
            nodeId: n.id,
            ...(issue.path === '' ? {} : { settingPath: issue.path }),
          }),
        );
      }
    }
  }
  return states;
}

/**
 * Check 3: edges and inputs. Returns the edges whose endpoints both exist and that the engine
 * follows (not from an output the node's settings hide).
 */
export function checkEdges(
  graph: WorkflowGraph,
  states: Map<string, NodeState>,
  issues: Issue[],
): Edge[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const existing: Edge[] = [];
  /** Edges from an output the node's settings hide (PORT_HIDDEN). */
  const hidden = new Set<Edge>();
  /** `${nodeId}\0${inputId}` → number of edges */
  const inputEdges = new Map<string, number>();
  for (const e of graph.edges) {
    const from = byId.get(e.from.node);
    const to = byId.get(e.to.node);
    if (!from || !to) {
      const missing = from ? e.to.node : e.from.node;
      issues.push(
        error('DANGLING_EDGE', `Edge ${e.id} points at missing node ${missing}`, { edgeId: e.id }),
      );
      continue;
    }
    existing.push(e);
    const fromDef = defOf(states.get(from.id));
    const toDef = defOf(states.get(to.id));
    const input = toDef?.inputs.find((p) => p.id === e.to.port);
    if (input) {
      const key = `${to.id}\0${input.id}`;
      inputEdges.set(key, (inputEdges.get(key) ?? 0) + 1);
    }
    // An edge touching an unknown-type node gets only the existence check.
    if (!fromDef || !toDef) continue;
    const out = fromDef.outputs.find((p) => p.id === e.from.port);
    if (!out || !input) {
      const problems = [
        ...(out ? [] : [`${title(from, fromDef)} has no output ${e.from.port}`]),
        ...(input ? [] : [`${title(to, toDef)} has no input ${e.to.port}`]),
      ];
      issues.push(error('UNKNOWN_PORT', problems.join('; '), { edgeId: e.id }));
      continue;
    }
    if (out.type !== input.type) {
      issues.push(
        error(
          'PORT_TYPE_MISMATCH',
          `${title(from, fromDef)} output ${out.label} (${out.type}) cannot connect to ${title(to, toDef)} input ${input.label} (${input.type})`,
          { edgeId: e.id },
        ),
      );
    }
    if (!portShown(out, from.settings)) {
      // Saved by an older client, or while the setting was different: the engine never follows
      // it, so the nodes behind it are not on any path either.
      issues.push(error('PORT_HIDDEN', hiddenPortText(from, fromDef, out), { edgeId: e.id }));
      hidden.add(e);
    }
  }
  for (const n of graph.nodes) {
    const def = defOf(states.get(n.id));
    if (!def) continue;
    for (const input of def.inputs) {
      const count = inputEdges.get(`${n.id}\0${input.id}`) ?? 0;
      // A file input takes any number of connections: a file follows one path per run, so the
      // edges into it merge branches that never both run. A data input takes one: its value is
      // read from the source on demand, and two sources would disagree.
      if (count > 1 && input.type !== 'file') {
        issues.push(
          error(
            'INPUT_MULTIPLE_EDGES',
            `${title(n, def)}: data input ${input.label} takes one connection, not ${count}`,
            {
              nodeId: n.id,
            },
          ),
        );
      } else if (count === 0 && isPortRequired(input)) {
        issues.push(
          error('INPUT_UNCONNECTED', `${title(n, def)}: input ${input.label} is not connected`, {
            nodeId: n.id,
          }),
        );
      }
    }
  }
  const followed = existing.filter((e) => !hidden.has(e));
  checkSharedOutputs(byId, states, followed, issues);
  return followed;
}
