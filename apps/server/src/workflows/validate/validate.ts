import { resolve as resolvePath } from 'node:path';
import {
  type DeviceProfileId,
  type Issue,
  type JsonValue,
  LIBRARY_INPUT_TYPE,
  syncLinkedSettings,
  valueNamed,
  type WorkflowGraph,
} from '@transcoda/shared';
import { resolveEncoder } from '../../engine/model/model.ts';
import {
  checkEncodeAudioSettings,
  checkEncodeVideoSettings,
  checkRemuxSettings,
  type TargetIssue,
} from '../../engine/model/targets.ts';
import { MOVE_COPY_TYPE, nodeAvailability } from '../../nodes/availability.ts';
import type { RegisteredNode } from '../../nodes/registry.ts';
import { adjacency, checkKindRules, findCycle } from './graph.ts';
import { defOf, error, title, warning } from './issues.ts';
import { checkEdges, checkNodes } from './nodes.ts';
import { checkPaths } from './paths.ts';
import { checkSubworkflowRefs, createValidationCache } from './subworkflows.ts';
import type { NodeState, ValidationContext } from './types.ts';

// Workflow validation: validateWorkflow runs every check in order. The checks are in the files
// beside this one; the setting-value checks that need the whole context are here.

export { behaviourHoldText } from './nodes.ts';
export { SIZE_GATE_SHARED_TEXT } from './outputs.ts';
export { createValidationCache, migratePinned } from './subworkflows.ts';
export type { SubworkflowRef, ValidationCache, ValidationContext } from './types.ts';

/** The static target check of a node's settings, or [] for nodes without `targets`. */
function targetIssues(type: string, s: Record<string, JsonValue>): TargetIssue[] {
  // The settings parsed against the node's schema, so these casts hold.
  const targets = s.targets as DeviceProfileId[];
  switch (type) {
    case 'core:encode-video':
      return checkEncodeVideoSettings({ codec: s.codec as string, targets });
    case 'core:encode-audio':
      return checkEncodeAudioSettings({ codec: s.codec as string, targets });
    case 'core:remux':
      return checkRemuxSettings({ container: s.container as 'mkv' | 'mp4', targets });
    default:
      return [];
  }
}

/** Setting-aware checks on nodes with valid current settings: output roots, targets, encoders. */
/** An absolute path resolved: no trailing slash, no `.`/`..` segments. */
const normalRoot = (p: string): string => resolvePath(p);

function checkSettingValues(
  graph: WorkflowGraph,
  states: Map<string, NodeState>,
  ctx: ValidationContext,
  issues: Issue[],
): void {
  const caps = ctx.capabilities;
  for (const n of graph.nodes) {
    const state = states.get(n.id);
    if (state?.status !== 'current' || state.settings === null) continue;
    const { def, settings: s } = state;
    const name = title(n, def);
    // With no roots at all the node is NODE_UNAVAILABLE instead. Compared resolved (a trailing
    // slash or `..` does not matter), as the pipeline compares them.
    if (
      def.type === MOVE_COPY_TYPE &&
      ctx.outputRoots.length > 0 &&
      !ctx.outputRoots.map(normalRoot).includes(normalRoot(s.outputRoot as string))
    ) {
      issues.push(
        error('INVALID_SETTINGS', 'outputRoot must be one of the configured output roots', {
          nodeId: n.id,
          settingPath: 'outputRoot',
        }),
      );
    }
    // A bypassed node runs no hook: its targets and encoder never matter (it may be bypassed
    // precisely because its encoder is missing here).
    if (n.bypassed === true) continue;
    for (const t of targetIssues(def.type, s)) {
      issues.push(
        error('TARGET_UNSUPPORTED', `${name}: ${t.message}`, {
          nodeId: n.id,
          settingPath: 'targets',
        }),
      );
    }
    // Without ffmpeg every encoder is missing; NODE_UNAVAILABLE / the capabilities say so.
    if (def.type === 'core:encode-video' && caps.available) {
      const codec = s.codec as 'hevc' | 'h264' | 'av1';
      const encoder = s.encoder as string;
      if (resolveEncoder(codec, encoder, caps) === null) {
        const message =
          encoder === 'auto'
            ? `${name}: no ${codec} encoder is available`
            : `${name}: encoder ${encoder} is not available`;
        issues.push(
          error('ENCODER_UNAVAILABLE', message, { nodeId: n.id, settingPath: 'encoder' }),
        );
      }
    }
  }
}

/** A Library input naming a library that does not exist (or is deleted). An empty id is INVALID_SETTINGS. */
function checkLibraries(graph: WorkflowGraph, ctx: ValidationContext, issues: Issue[]): void {
  const exists = ctx.libraryExists;
  if (!exists) return;
  for (const n of graph.nodes) {
    if (n.type !== LIBRARY_INPUT_TYPE) continue;
    const settings = n.settings;
    const id =
      settings !== null && typeof settings === 'object' && !Array.isArray(settings)
        ? settings.libraryId
        : undefined;
    if (typeof id !== 'string' || id === '' || exists(id)) continue;
    issues.push(
      warning('LIBRARY_MISSING', 'Library input: no library with this id', {
        nodeId: n.id,
        settingPath: 'libraryId',
      }),
    );
  }
}

/** A node whose `groupId` names no group (harmless for the engine; the editor should not see it). */
function checkGroups(graph: WorkflowGraph, states: Map<string, NodeState>, issues: Issue[]): void {
  const groups = new Set(graph.groups.map((g) => g.id));
  for (const n of graph.nodes) {
    if (n.groupId === undefined || groups.has(n.groupId)) continue;
    issues.push(
      warning(
        'GROUP_MISSING',
        `${title(n, defOf(states.get(n.id)))} is in group ${n.groupId}, which does not exist`,
        { nodeId: n.id },
      ),
    );
  }
}

/** A setting that follows a shared value the graph does not have (the setting keeps its copy). */
function checkValueLinks(
  graph: WorkflowGraph,
  states: Map<string, NodeState>,
  issues: Issue[],
): void {
  for (const n of graph.nodes) {
    for (const [key, name] of Object.entries(n.links ?? {})) {
      if (valueNamed(graph, name)) continue;
      issues.push(
        warning(
          'VALUE_MISSING',
          `${title(n, defOf(states.get(n.id)))} follows the shared value "${name}", which does not exist`,
          { nodeId: n.id, settingPath: key },
        ),
      );
    }
  }
}

export function validateWorkflow(sent: WorkflowGraph, ctx: ValidationContext): Issue[] {
  // Linked settings are judged by the value they follow.
  const graph = syncLinkedSettings(sent);
  const cache = ctx.cache ?? createValidationCache();
  const issues: Issue[] = [];
  const states = checkNodes(graph, ctx, issues);
  const edges = checkEdges(graph, states, issues);
  const next = adjacency(graph, edges);
  const cycle = findCycle(graph, next);
  if (cycle) {
    issues.push(
      error('GRAPH_CYCLE', `The workflow has a cycle: ${cycle.join(' → ')}`, {
        nodeId: cycle[0] as string,
      }),
    );
  }
  checkKindRules(graph, states, edges, next, issues);
  checkPaths(graph, states, edges, issues);
  checkSettingValues(graph, states, ctx, issues);
  checkSubworkflowRefs(graph, states, ctx, cache, issues, validateWorkflow);
  for (const n of graph.nodes) {
    const def = defOf(states.get(n.id));
    if (!def) continue;
    // A node with a definition always has its registry entry (the definition came from it).
    const entry = ctx.registry.get(n.type) as RegisteredNode;
    const down = entry.unavailable?.() ?? null;
    if (down !== null) {
      // The settings were still validated above (the persisted schema stays known).
      issues.push(
        error('PLUGIN_UNAVAILABLE', `${title(n, def)} can't run: ${down}`, { nodeId: n.id }),
      );
      continue;
    }
    const availability = nodeAvailability(entry, ctx.capabilities, {
      outputRoots: ctx.outputRoots,
    });
    if (!availability.available) {
      issues.push(
        error('NODE_UNAVAILABLE', `${title(n, def)} is unavailable here: ${availability.reason}`, {
          nodeId: n.id,
        }),
      );
    }
  }
  checkLibraries(graph, ctx, issues);
  checkGroups(graph, states, issues);
  checkValueLinks(graph, states, issues);
  return issues;
}
