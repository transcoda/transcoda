import { defineNode } from '@transcoda/sdk';
import {
  type Edge,
  FINISH_PHASES,
  type FinishPhase,
  finishPhaseRank,
  type NodeInstance,
  type WorkflowGraph,
} from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { filePort } from '../../nodes/core/common.ts';
import {
  bareGraph,
  chain,
  childGraph,
  edge,
  mainGraph,
  node,
  subGraph,
  testRegistry,
} from '../test-helpers.ts';
import { walkPathRules } from './paths.ts';
import { codes, ctx, find, mainWith, runNode } from './testing.ts';
import { type SubworkflowRef, validateWorkflow } from './validate.ts';

describe('validateWorkflow', () => {
  describe('finish order and write paths', () => {
    /** in → vi, plus the given edges out of vi (ports pass/else) and the nodes they reach. */
    function branching(
      rest: ReturnType<typeof node>[],
      edges: ReturnType<typeof edge>[],
    ): WorkflowGraph {
      return mainGraph(
        [node('in', 'core:input-manual'), node('vi', 'core:video-is'), ...rest],
        [edge('in', 'vi'), ...edges],
      );
    }

    it('FINISH_ORDER: replace before size gate', () => {
      const g = chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('ro', 'core:replace-original'),
        node('sg', 'core:size-gate'),
      );
      expect(validateWorkflow(g, ctx())).toEqual([
        {
          severity: 'error',
          code: 'FINISH_ORDER',
          message:
            'Size gate (gate) comes after Replace original (write); finish nodes run render → gate → write → library manager → media server → notify',
          nodeId: 'sg',
        },
      ]);
      // the same with move-copy
      const mc = chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('mc', 'core:move-copy', { outputRoot: '/out' }),
        node('sg', 'core:size-gate'),
      );
      expect(find(validateWorkflow(mc, ctx()), 'FINISH_ORDER').map((i) => i.nodeId)).toEqual([
        'sg',
      ]);
      // a gate before the write is fine
      expect(validateWorkflow(mainWith(node('sg', 'core:size-gate')), ctx())).toEqual([]);
    });

    describe('OUTPUT_MULTIPLE_EDGES', () => {
      const hook = (id: string) => node(id, 'core:notify-webhook', { url: 'https://e.test/h' });

      it('several finish nodes on one output are fine (they run in phase order)', () => {
        const g = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('ro', 'core:replace-original'),
            hook('a'),
            hook('b'),
          ],
          [edge('in', 'ro'), edge('ro', 'a'), edge('ro', 'b')],
        );
        expect(validateWorkflow(g, ctx())).toEqual([]);
        // on the size gate's pass and else too
        const gate = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('sg', 'core:size-gate'),
            node('ro', 'core:replace-original'),
            hook('p'),
            hook('e1'),
            hook('e2'),
          ],
          [
            edge('in', 'sg'),
            edge('sg', 'ro', { from: 'pass' }),
            edge('sg', 'p', { from: 'pass' }),
            edge('sg', 'e1', { from: 'else' }),
            edge('sg', 'e2', { from: 'else' }),
          ],
        );
        expect(find(validateWorkflow(gate, ctx()), 'OUTPUT_MULTIPLE_EDGES')).toEqual([]);
      });

      it('an output shared with anything but finish nodes is an error on the node it leaves', () => {
        const g = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('kl', 'core:keep-languages', { languages: ['en'] }),
            node('ro', 'core:replace-original'),
          ],
          [edge('in', 'kl'), edge('in', 'ro'), edge('kl', 'ro', { to: 'file' })],
        );
        // one issue per offending edge (drawn broken), none for the edge to the finish node
        expect(find(validateWorkflow(g, ctx()), 'OUTPUT_MULTIPLE_EDGES')).toEqual([
          {
            severity: 'error',
            code: 'OUTPUT_MULTIPLE_EDGES',
            message:
              'Manual input: output File has 2 connections, one to Keep languages; only finish steps can share an output (a file follows one path)',
            nodeId: 'in',
            edgeId: 'in-kl',
          },
        ]);
        // a data output may feed several nodes
        const data = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('d', 'test:data-language'),
            node('k1', 'core:keep-languages', { languages: ['en'] }),
            node('k2', 'core:keep-languages', { languages: ['en'] }),
            node('ro', 'core:replace-original'),
          ],
          [
            edge('in', 'k1'),
            edge('k1', 'k2'),
            edge('k2', 'ro'),
            edge('d', 'k1', { from: 'language', to: 'language' }),
            edge('d', 'k2', { from: 'language', to: 'language' }),
          ],
        );
        expect(find(validateWorkflow(data, ctx()), 'OUTPUT_MULTIPLE_EDGES')).toEqual([]);
      });

      it('in a sub-workflow, sharing an output is always an error (it has no finish nodes)', () => {
        const g = subGraph(
          [
            node('k1', 'core:keep-languages', { languages: ['en'] }),
            node('k2', 'core:keep-languages', { languages: ['de'] }),
          ],
          [edge('start', 'k1'), edge('start', 'k2'), edge('k1', 'end'), edge('k2', 'end')],
        );
        expect(find(validateWorkflow(g, ctx()), 'OUTPUT_MULTIPLE_EDGES')).toEqual([
          expect.objectContaining({ severity: 'error', nodeId: 'start', edgeId: 'start-k1' }),
          expect.objectContaining({ severity: 'error', nodeId: 'start', edgeId: 'start-k2' }),
        ]);
      });

      it('a Run node\u2019s output may feed several finish nodes', () => {
        const subs = new Map<string, SubworkflowRef>([
          ['child@1', { graph: childGraph(), currentVersion: 1 }],
        ]);
        const g = mainGraph(
          [
            node('in', 'core:input-manual'),
            runNode('r', 'child', 1),
            node('ro', 'core:replace-original'),
            hook('a'),
          ],
          [edge('in', 'r'), edge('r', 'ro'), edge('r', 'a')],
        );
        expect(validateWorkflow(g, ctx({ subs }))).toEqual([]);
        // with an action among them, the Run node is blamed, on that edge
        g.nodes.push(node('kl', 'core:keep-languages', { languages: ['en'] }));
        g.edges.push(edge('r', 'kl'));
        expect(find(validateWorkflow(g, ctx({ subs })), 'OUTPUT_MULTIPLE_EDGES')).toEqual([
          expect.objectContaining({ nodeId: 'r', edgeId: 'r-kl' }),
        ]);
      });

      it('SIZE_GATE_SHARED_OUTPUT: a size gate must be the only step on its output', () => {
        const g = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('ev', 'core:remux', { container: 'mkv' }),
            node('sg', 'core:size-gate'),
            node('ro', 'core:replace-original'),
            hook('n'),
          ],
          [edge('in', 'ev'), edge('ev', 'sg'), edge('ev', 'n'), edge('sg', 'ro', { from: 'pass' })],
        );
        const issues = validateWorkflow(g, ctx());
        expect(find(issues, 'SIZE_GATE_SHARED_OUTPUT')).toEqual([
          {
            severity: 'error',
            code: 'SIZE_GATE_SHARED_OUTPUT',
            message:
              'The size gate must be the only step on this output; put the other steps after the gate\u2019s Yes or No.',
            nodeId: 'sg',
            edgeId: 'ev-sg',
          },
        ]);
        expect(find(issues, 'OUTPUT_MULTIPLE_EDGES')).toEqual([]);
        // a bypassed gate runs no hook, so it decides nothing and may share
        const sg = g.nodes.find((n) => n.id === 'sg');
        if (sg) sg.bypassed = true;
        expect(find(validateWorkflow(g, ctx()), 'SIZE_GATE_SHARED_OUTPUT')).toEqual([]);
      });

      it('OUTPUT_MULTIPLE_WRITES: one step that writes the result per output', () => {
        const writes = (second: ReturnType<typeof node>) =>
          mainGraph(
            [
              node('in', 'core:input-manual'),
              node('ro', 'core:replace-original'),
              second,
              hook('n'),
            ],
            [edge('in', 'ro'), edge('in', second.id), edge('in', 'n')],
          );
        const mc = validateWorkflow(
          writes(node('mc', 'core:move-copy', { outputRoot: '/out' })),
          ctx(),
        );
        expect(find(mc, 'OUTPUT_MULTIPLE_WRITES')).toEqual([
          {
            severity: 'error',
            code: 'OUTPUT_MULTIPLE_WRITES',
            message:
              'Replace original: Render\u2019s output Done has 2 steps that write the result; only one of them can be on an output',
            nodeId: 'ro',
            edgeId: 'in-ro',
          },
          expect.objectContaining({
            code: 'OUTPUT_MULTIPLE_WRITES',
            nodeId: 'mc',
            edgeId: 'in-mc',
          }),
        ]);
        const two = validateWorkflow(writes(node('ro2', 'core:replace-original')), ctx());
        expect(find(two, 'OUTPUT_MULTIPLE_WRITES').map((i) => i.nodeId)).toEqual(['ro', 'ro2']);
        // a bypassed one does not write
        const bypassed = writes(node('ro2', 'core:replace-original', {}, { bypassed: true }));
        expect(find(validateWorkflow(bypassed, ctx()), 'OUTPUT_MULTIPLE_WRITES')).toEqual([]);
      });
    });

    it('FINISH_ORDER: an action after a finish node', () => {
      const g = chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('sg', 'core:size-gate'),
        node('ro', 'core:replace-original'),
        node('kl', 'core:keep-languages'),
      );
      expect(validateWorkflow(g, ctx())).toEqual([
        {
          severity: 'error',
          code: 'FINISH_ORDER',
          message: 'Keep languages comes after a finish node; only finish nodes may follow one',
          nodeId: 'kl',
        },
      ]);
      // finish after finish is fine (notify after replace)
      const notify = chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('ro', 'core:replace-original'),
        node('nw', 'core:notify-webhook', { url: 'https://example.test/hook' }),
      );
      expect(validateWorkflow(notify, ctx())).toEqual([]);
    });

    describe('size gate else', () => {
      const ELSE_TEXT =
        'After the size gate\u2019s \u201cNo\u201d, only notifications and other non-writing finish steps can follow.';
      const notify = () => node('nw', 'core:notify-webhook', { url: 'https://example.test/hook' });
      /** in → sg; sg.pass → ro; sg.else → `after`. */
      const gate = (after: ReturnType<typeof node>[], elseEdges: ReturnType<typeof edge>[]) =>
        mainGraph(
          [
            node('in', 'core:input-manual'),
            node('sg', 'core:size-gate'),
            node('ro', 'core:replace-original'),
            ...after,
          ],
          [edge('in', 'sg'), edge('sg', 'ro', { from: 'pass' }), ...elseEdges],
        );
      const elseTo = (id: string) => edge('sg', id, { from: 'else' });
      const phaseOf = (phase: FinishPhase) =>
        defineNode({
          type: `test:else-${phase}`,
          version: 1,
          kind: 'finish',
          finishPhase: phase,
          title: `Else ${phase}`,
          description: 'd',
          icon: 'x',
          inputs: [filePort],
          outputs: [filePort],
          settings: z.object({}),
        });
      const phaseCtx = () => ctx({ registry: testRegistry(...FINISH_PHASES.map(phaseOf)) });

      it('else → notify is valid, and so is an unconnected else', () => {
        expect(validateWorkflow(gate([notify()], [elseTo('nw')]), ctx())).toEqual([]);
        expect(validateWorkflow(gate([], []), ctx())).toEqual([]);
      });

      it('else → replace-original and else → move-copy are errors with the exact text', () => {
        expect(
          validateWorkflow(gate([node('rb', 'core:replace-original')], [elseTo('rb')]), ctx()),
        ).toEqual([
          { severity: 'error', code: 'ELSE_ONLY_NOTIFY', message: ELSE_TEXT, nodeId: 'rb' },
        ]);
        const mc = node('mc', 'core:move-copy', { mode: 'copy', outputRoot: '/out' });
        expect(validateWorkflow(gate([mc], [elseTo('mc')]), ctx())).toEqual([
          { severity: 'error', code: 'ELSE_ONLY_NOTIFY', message: ELSE_TEXT, nodeId: 'mc' },
        ]);
      });

      it('later nodes of the else chain are checked too; a second size gate is refused', () => {
        const g = gate(
          [notify(), node('rb', 'core:replace-original')],
          [elseTo('nw'), edge('nw', 'rb')],
        );
        expect(find(validateWorkflow(g, ctx()), 'ELSE_ONLY_NOTIFY').map((i) => i.nodeId)).toEqual([
          'rb',
        ]);
        const two = gate([node('sg2', 'core:size-gate')], [elseTo('sg2')]);
        expect(find(validateWorkflow(two, ctx()), 'ELSE_ONLY_NOTIFY').map((i) => i.nodeId)).toEqual(
          ['sg2'],
        );
      });

      it('an action after else is FINISH_ORDER as after any finish node; the else path needs no write', () => {
        const g = gate([node('kl', 'core:keep-languages')], [elseTo('kl')]);
        // the else path ends without a write, and that is not a NO_WRITE_PATH warning
        expect(codes(validateWorkflow(g, ctx()))).toEqual(['error:FINISH_ORDER']);
        expect(validateWorkflow(gate([notify()], [elseTo('nw')]), ctx())).toEqual([]);
      });

      it.each(FINISH_PHASES)('else → a plugin finish step in phase %s', (phase) => {
        const g = gate([node('p', `test:else-${phase}`)], [elseTo('p')]);
        const found = find(validateWorkflow(g, phaseCtx()), 'ELSE_ONLY_NOTIFY');
        if (phase === 'render' || phase === 'gate' || phase === 'write')
          expect(found.map((i) => i.nodeId)).toEqual(['p']);
        else expect(found).toEqual([]);
      });

      it('a bypassed write after else runs nothing, so it is not an error', () => {
        const g = gate(
          [node('rb', 'core:replace-original', {}, { bypassed: true })],
          [elseTo('rb')],
        );
        expect(find(validateWorkflow(g, ctx()), 'ELSE_ONLY_NOTIFY')).toEqual([]);
      });

      it('Yes and No may both lead into one notify (each path is checked on its own); both into a write is still ELSE_ONLY_NOTIFY', () => {
        /** in → r → sg; sg.pass → ro → `shared`; sg.else → `shared`. */
        const merged = (shared: NodeInstance, passEdges: Edge[]) =>
          bareGraph(
            [
              node('in', 'core:input-manual'),
              node('r', 'core:render'),
              node('sg', 'core:size-gate'),
              node('ro', 'core:replace-original'),
              shared,
            ],
            [
              edge('in', 'r'),
              edge('r', 'sg', { from: 'done' }),
              edge('sg', 'ro', { from: 'pass' }),
              ...passEdges,
              edge('sg', shared.id, { from: 'else' }),
            ],
          );
        expect(validateWorkflow(merged(notify(), [edge('ro', 'nw')]), ctx())).toEqual([]);
        // Yes and No both into Replace original: fine on Yes, a write below No
        const intoWrite = bareGraph(
          [
            node('in', 'core:input-manual'),
            node('r', 'core:render'),
            node('sg', 'core:size-gate'),
            node('ro', 'core:replace-original'),
          ],
          [
            edge('in', 'r'),
            edge('r', 'sg', { from: 'done' }),
            edge('sg', 'ro', { from: 'pass' }),
            { ...edge('sg', 'ro', { from: 'else' }), id: 'sg-ro-else' },
          ],
        );
        expect(validateWorkflow(intoWrite, ctx())).toEqual([
          { severity: 'error', code: 'ELSE_ONLY_NOTIFY', message: ELSE_TEXT, nodeId: 'ro' },
        ]);
      });

      it('a pass chain still warns when it never writes; only else is exempt', () => {
        const g = mainGraph(
          [node('in', 'core:input-manual'), node('sg', 'core:size-gate'), notify()],
          [edge('in', 'sg'), edge('sg', 'nw', { from: 'pass' })],
        );
        expect(validateWorkflow(g, ctx()).map((i) => [i.code, i.nodeId])).toEqual([
          ['NO_WRITE_PATH', 'nw'],
        ]);
      });
    });

    describe('finish phases', () => {
      const phaseNode = (phase: FinishPhase) =>
        defineNode({
          type: `test:phase-${phase}`,
          version: 1,
          kind: 'finish',
          finishPhase: phase,
          title: `Phase ${phase}`,
          description: 'd',
          icon: 'x',
          inputs: [filePort],
          outputs: [filePort],
          settings: z.object({}),
        });
      const phaseCtx = () => ctx({ registry: testRegistry(...FINISH_PHASES.map(phaseNode)) });
      const pairs = FINISH_PHASES.flatMap((a) => FINISH_PHASES.map((b) => [a, b] as const));

      it.each(pairs)('%s then %s', (first, second) => {
        const g = chain(
          'workflow',
          node('in', 'core:input-manual'),
          node('a', `test:phase-${first}`),
          node('b', `test:phase-${second}`),
        );
        const issues = find(validateWorkflow(g, phaseCtx()), 'FINISH_ORDER');
        if (finishPhaseRank(second) >= finishPhaseRank(first)) {
          expect(issues).toEqual([]);
        } else {
          expect(issues).toEqual([
            {
              severity: 'error',
              code: 'FINISH_ORDER',
              message: `Phase ${second} (${second}) comes after Phase ${first} (${first}); finish nodes run render → gate → write → library manager → media server → notify`,
              nodeId: 'b',
            },
          ]);
        }
      });

      it('a bypassed finish node sets no phase', () => {
        const bypassedNotify = { ...node('a', 'test:phase-notify'), bypassed: true };
        const g = chain(
          'workflow',
          node('in', 'core:input-manual'),
          bypassedNotify,
          node('b', 'test:phase-gate'),
        );
        expect(find(validateWorkflow(g, phaseCtx()), 'FINISH_ORDER')).toEqual([]);
      });
    });

    it('NO_WRITE_PATH warning on a path that ends without replace or move', () => {
      const g = branching(
        [
          node('sg', 'core:size-gate'),
          node('ro', 'core:replace-original'),
          node('kl', 'core:keep-languages'),
        ],
        [
          edge('vi', 'sg', { from: 'pass' }),
          edge('sg', 'ro', { from: 'pass' }),
          edge('vi', 'kl', { from: 'else' }),
        ],
      );
      expect(validateWorkflow(g, ctx())).toEqual([
        {
          severity: 'warning',
          code: 'NO_WRITE_PATH',
          message: 'this path never writes the result',
          nodeId: 'kl',
        },
      ]);
      // a bypassed replace does not write either
      const bypassed = chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('ro', 'core:replace-original', {}, { bypassed: true }),
      );
      expect(validateWorkflow(bypassed, ctx()).map((i) => [i.code, i.nodeId])).toEqual([
        ['NO_WRITE_PATH', 'ro'],
      ]);
    });

    it('NO_WRITE_PATH is port-aware: a condition with only else connected warns on pass; a diamond is walked once per (node, flags)', () => {
      const g = branching(
        [node('sg', 'core:size-gate'), node('ro', 'core:replace-original')],
        [edge('vi', 'sg', { from: 'else' }), edge('sg', 'ro', { from: 'pass' })],
      );
      expect(validateWorkflow(g, ctx())).toEqual([
        {
          severity: 'warning',
          code: 'NO_WRITE_PATH',
          message: 'this path never writes the result (output "Yes" is unconnected)',
          nodeId: 'vi',
        },
      ]);

      // in → kl → {a0, a1, a2} → (a Render each) → sg → ro: sg and ro are expanded once, not
      // three times
      const wide = ['a0', 'a1', 'a2'];
      const diamond = mainGraph(
        [
          node('in', 'core:input-manual'),
          node('kl', 'core:keep-languages'),
          ...wide.map((id) => node(id, 'core:keep-languages')),
          node('sg', 'core:size-gate'),
          node('ro', 'core:replace-original'),
        ],
        [
          edge('in', 'kl'),
          ...wide.flatMap((id) => [edge('kl', id), edge(id, 'sg')]),
          edge('sg', 'ro', { from: 'pass' }),
        ],
      );
      expect(walkPathRules(diamond, ctx())).toEqual({ issues: [], visits: 10 });

      // 20 stacked 3-wide diamonds: 3^20 paths, but every node is expanded once
      const nodes = [node('in', 'core:input-manual'), node('h0', 'core:keep-languages')];
      const edges = [edge('in', 'h0')];
      for (let level = 0; level < 20; level++) {
        nodes.push(node(`h${level + 1}`, 'core:keep-languages'));
        for (const w of wide) {
          const id = `l${level}${w}`;
          nodes.push(node(id, 'core:keep-languages'));
          edges.push(edge(`h${level}`, id), edge(id, `h${level + 1}`));
        }
      }
      nodes.push(node('ro', 'core:replace-original'));
      edges.push(edge('h20', 'ro'));
      const stacked = mainGraph(nodes, edges);
      expect(walkPathRules(stacked, ctx())).toEqual({
        issues: [],
        visits: stacked.nodes.length,
      });
    });
  });
});
