import type { NodeInfo } from '@transcoda/contract';
import type { Group, JsonValue, NodeInstance, SharedValues, WorkflowKind } from '@transcoda/shared';
import type { Edge, Node } from '@xyflow/react';
import type { PortType } from '../../hooks/useCatalog.ts';
import type { GroupProblem } from '../model/group-state.ts';
import type { NodeState } from '../model/issues.ts';

/** One node's part of a job's trace (Phase B; defined here so Phase A compiles alone). */
export type TraceNodeData = {
  /** `failed`: the node's last entry says `failed: …` (Task 23). */
  status: 'done' | 'current' | 'untaken' | 'pending' | 'failed';
  reason: string | null;
  port: string | null;
  findings: Record<string, JsonValue>;
  attempt: number;
  retried: boolean;
  /** The entry was written by a plugin (the plug icon beside the node's reason). */
  plugin?: boolean;
  /** The current node's activity line ("Encoding · 42%"); set by the trace canvas (Task 23). */
  activity?: string;
  /** The current node's progress, 0-100; absent when the job reports none (no fill is drawn). */
  progress?: number;
  /** The job is paused at this (current) node: lit, but not moving. */
  paused?: boolean;
  /** A Run node the file entered: its sub-workflow can be opened below the canvas (Task 23). */
  expandable?: boolean;
  expanded?: boolean;
};

export interface TraceOverlay {
  nodes: Map<string, TraceNodeData>;
  edges: Map<string, { taken: boolean; untaken: boolean; value: string | null }>;
  currentNodeId: string | null;
}

export type TcNodeData = {
  instance: NodeInstance;
  def: NodeInfo | null;
  state: NodeState;
  graphKind: WorkflowKind;
  trace?: TraceNodeData;
};

export type TcGroupData = {
  group: Group;
  count: number;
  /** A collapsed group's hidden members' worst state (N10); null when expanded or all clean. */
  problem: GroupProblem | null;
};

export type TcEdgeData = {
  portType: PortType | null;
  broken: boolean;
  /** Phase B. */
  taken?: boolean;
  untaken?: boolean;
  value?: string;
};

export type TcValuesData = {
  values: SharedValues;
  /** Value name → how many nodes follow it. */
  uses: Record<string, number>;
};

export type TcNode = Node<TcNodeData, 'tc-node'>;
export type TcGroupNode = Node<TcGroupData, 'tc-group'>;
export type TcValuesNode = Node<TcValuesData, 'tc-values'>;
export type TcFlowNode = TcNode | TcGroupNode | TcValuesNode;
export type TcEdge = Edge<TcEdgeData, 'tc-edge'>;
/** A dotted line from the values card to a node that follows one of its values (never edited). */
export type TcLinkEdge = Edge<Record<string, never>, 'tc-link'>;
export type TcFlowEdge = TcEdge | TcLinkEdge;
