import type { Capabilities } from '@transcoda/contract';
import type { AnyNodeDefinition } from '@transcoda/sdk';
import type { Issue, JsonValue, WorkflowGraph } from '@transcoda/shared';
import type { NodeRegistry } from '../../nodes/registry.ts';

// The validator's context and the state it builds up: what a node resolved to, the sub-workflow memo.

export interface SubworkflowRef {
  graph: WorkflowGraph;
  currentVersion: number;
}

export interface ValidationContext {
  registry: NodeRegistry;
  capabilities: Capabilities;
  /** Configured output roots (`TRANSCODA_OUTPUT_ROOTS`); `core:move-copy` must use one of them. */
  outputRoots: string[];
  /** null when the id is unknown, soft-deleted, not kind 'subworkflow', or the version does not exist / is corrupt. */
  resolveSubworkflow(id: string, version: number): SubworkflowRef | null;
  /** The saved workflow being validated (self-reference cycles). */
  self?: { id: string };
  /** Memo for pinned sub-workflows; pass one to share it across several validations. */
  cache?: ValidationCache;
  /**
   * Whether a live library has this id. When given, a Library input naming any other non-empty
   * id gets a LIBRARY_MISSING warning (it blocks activation, not saving or dry runs).
   */
  libraryExists?: (id: string) => boolean;
}

export type NodeState =
  | { status: 'unknown' }
  | { status: 'newer' | 'outdated'; def: AnyNodeDefinition }
  | {
      status: 'current';
      def: AnyNodeDefinition;
      /** The parsed settings (defaults applied); null when they are invalid. */
      settings: Record<string, JsonValue> | null;
    };

/** One problem inside a pinned sub-workflow; `chain` names the sub-workflows below it (`<id> version <v>`). */
export interface ChildProblem {
  chain: string[];
  message: string;
}

/**
 * Per-call (or, shared by the caller, per-listing) memo for validating pinned sub-workflows.
 * Results computed while a reference cycle was cut short may miss problems behind the cycle;
 * every Run node reaching such a cycle gets SUBWORKFLOW_REFERENCE_CYCLE anyway.
 */
export interface ValidationCache {
  /** `${id}@${version}#${overrides}` → the errors found in that child with those overrides. */
  results: Map<string, ChildProblem[]>;
  /** `${id}@${version}` of the children being validated (the recursion stack). */
  active: Set<string>;
  /** SUBWORKFLOW_BROKEN issues made inside a child → the problem they carry, for the chain. */
  nested: WeakMap<Issue, { ref: string; problem: ChildProblem }>;
  /** `${id}@${version}` → what `ctx.resolveSubworkflow` returned (looked up once per cache). */
  resolved: Map<string, SubworkflowRef | null>;
  /** `${id}@${version}` → the sub-workflow ids it reaches, for refs explored without a cycle. */
  clean: Map<string, Set<string>>;
}

/** `validateWorkflow`, passed down to validate a pinned sub-workflow whole (the files beside it never import the entry). */
export type Validate = (graph: WorkflowGraph, ctx: ValidationContext) => Issue[];
