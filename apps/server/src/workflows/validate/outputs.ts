import { type AnyNodeDefinition, nodeMetadata, type PortSpec } from '@transcoda/sdk';
import { type Edge, type Issue, type NodeInstance, RENDER_TYPE } from '@transcoda/shared';
import { MOVE_COPY_TYPE, SIZE_GATE_TYPE } from '../../nodes/availability.ts';
import { defOf, error, title } from './issues.ts';
import type { NodeState } from './types.ts';

// File outputs: a hidden output's message, and which steps may share one output.

/** The words for the setting a port's `shownWhen` names: its label, else its key. */
function settingWords(def: AnyNodeDefinition, key: string): string {
  try {
    const schema = nodeMetadata(def).settingsSchema;
    const props =
      typeof schema === 'object' && schema !== null && !Array.isArray(schema)
        ? schema.properties
        : undefined;
    const prop =
      typeof props === 'object' && props !== null && !Array.isArray(props) ? props[key] : undefined;
    const label =
      typeof prop === 'object' && prop !== null && !Array.isArray(prop)
        ? prop.description
        : undefined;
    return typeof label === 'string' && label !== '' ? label : key;
  } catch {
    return key;
  }
}

/** PORT_HIDDEN: `<node>: output "Damaged" is only there while Quality check is on; …`. */
export function hiddenPortText(n: NodeInstance, def: AnyNodeDefinition, out: PortSpec): string {
  const when = out.shownWhen;
  if (!when) return `${title(n, def)}: output "${out.label}" is hidden`;
  const words = settingWords(def, when.setting);
  const state =
    when.equals === true
      ? { is: `${words} is on`, fix: `turn ${words} on` }
      : when.equals === false
        ? { is: `${words} is off`, fix: `turn ${words} off` }
        : {
            is: `${words} is ${JSON.stringify(when.equals)}`,
            fix: `set ${words} to ${JSON.stringify(when.equals)}`,
          };
  return `${title(n, def)}: output "${out.label}" is only there while ${state.is}; remove the connection or ${state.fix}`;
}

/** SIZE_GATE_SHARED_OUTPUT: the gate decides for the steps after it, not for its siblings. */
export const SIZE_GATE_SHARED_TEXT =
  'The size gate must be the only step on this output; put the other steps after the gate\u2019s Yes or No.';

/** RENDER_SHARED_OUTPUT: Render makes the result its siblings would act on. */
export const RENDER_SHARED_TEXT =
  'Render must be the only step on this output; put the other steps after Render\u2019s Done or Damaged';

/** Finish nodes that write the result (replace the original, or write it under an output root). */
export const WRITE_TYPES: ReadonlySet<string> = new Set(['core:replace-original', MOVE_COPY_TYPE]);

/**
 * A file follows one path, so a file output may feed several nodes only when every one is a
 * finish node (they all act on the one result and run in phase order; the engine's walk does the
 * same). One issue per offending edge, so the editor draws it broken:
 * - OUTPUT_MULTIPLE_EDGES (on the node the output leaves): an edge to a node that is not a
 *   finish node;
 * - SIZE_GATE_SHARED_OUTPUT (on the gate): a size gate among them; it would decide only for the
 *   steps wired after it, and the others would run whatever it decides;
 * - RENDER_SHARED_OUTPUT (on the Render): a Render among them; the others would act on a result
 *   that is not rendered yet;
 * - OUTPUT_MULTIPLE_WRITES (on each writing step): two or more steps that write the result.
 * Data outputs may feed any number of nodes. Targets of unknown type are left to their own
 * issue; bypassed finish targets run no hook, so they neither gate nor write.
 */
export function checkSharedOutputs(
  byId: Map<string, NodeInstance>,
  states: Map<string, NodeState>,
  edges: Edge[],
  issues: Issue[],
): void {
  const byOutput = new Map<string, Edge[]>();
  for (const e of edges) {
    const key = `${e.from.node}\0${e.from.port}`;
    const list = byOutput.get(key);
    if (list) list.push(e);
    else byOutput.set(key, [e]);
  }
  for (const shared of byOutput.values()) {
    if (shared.length < 2) continue;
    const fromId = (shared[0] as Edge).from.node;
    const from = byId.get(fromId);
    const def = defOf(states.get(fromId));
    const out = def?.outputs.find((p) => p.id === (shared[0] as Edge).from.port);
    if (!from || !def || out?.type !== 'file') continue;
    const where = `${title(from, def)}\u2019s output ${out.label}`;
    const targets = shared.flatMap((e) => {
      const to = byId.get(e.to.node);
      const toDef = defOf(states.get(e.to.node));
      return to && toDef ? [{ e, to, toDef, runs: to.bypassed !== true }] : [];
    });
    const writes = targets.filter(
      (t) =>
        t.runs &&
        t.toDef.kind === 'finish' &&
        (WRITE_TYPES.has(t.toDef.type) || t.toDef.finishPhase === 'write'),
    );
    for (const { e, to, toDef, runs } of targets) {
      if (toDef.kind !== 'finish') {
        issues.push(
          error(
            'OUTPUT_MULTIPLE_EDGES',
            `${title(from, def)}: output ${out.label} has ${shared.length} connections, one to ${title(to, toDef)}; only finish steps can share an output (a file follows one path)`,
            { nodeId: fromId, edgeId: e.id },
          ),
        );
      } else if (runs && toDef.type === RENDER_TYPE) {
        issues.push(
          error('RENDER_SHARED_OUTPUT', RENDER_SHARED_TEXT, { nodeId: to.id, edgeId: e.id }),
        );
      } else if (runs && (toDef.type === SIZE_GATE_TYPE || toDef.finishPhase === 'gate')) {
        issues.push(
          error('SIZE_GATE_SHARED_OUTPUT', SIZE_GATE_SHARED_TEXT, { nodeId: to.id, edgeId: e.id }),
        );
      } else if (writes.length > 1 && writes.some((w) => w.e === e)) {
        issues.push(
          error(
            'OUTPUT_MULTIPLE_WRITES',
            `${title(to, toDef)}: ${where} has ${writes.length} steps that write the result; only one of them can be on an output`,
            { nodeId: to.id, edgeId: e.id },
          ),
        );
      }
    }
  }
}
