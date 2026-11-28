import { defineNode } from '@transcoda/sdk';
import type { Edge, NodeInstance, WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { filePort } from '../../nodes/core/common.ts';
import { bareGraph, chain, edge, node, testRegistry } from '../testing.ts';
import { codes, ctx, find } from './testing.ts';
import { validateWorkflow } from './validate.ts';

describe('validateWorkflow', () => {
  describe('Render', () => {
    const notifyNode = (id = 'nw') =>
      node(id, 'core:notify-webhook', { url: 'https://example.test/hook' });
    const replaceDamaged = defineNode({
      type: 'test:replace-damaged',
      version: 1,
      kind: 'finish',
      finishPhase: 'library-manager',
      damagedOnly: true,
      title: 'Replace damaged file',
      description: 'd',
      icon: 'x',
      inputs: [filePort],
      outputs: [filePort],
      settings: z.object({}),
    });
    const damagedCtx = () => ctx({ registry: testRegistry(replaceDamaged) });
    /** in → enc → r (Render) → ro; r.damaged → `after` by `damagedEdges`. */
    const rendered = (
      qualityCheck: boolean,
      after: ReturnType<typeof node>[] = [],
      damagedEdges: ReturnType<typeof edge>[] = [],
    ) =>
      bareGraph(
        [
          node('in', 'core:input-manual'),
          node('kl', 'core:keep-languages'),
          node('r', 'core:render', { qualityCheck }),
          node('ro', 'core:replace-original'),
          ...after,
        ],
        [edge('in', 'kl'), edge('kl', 'r'), edge('r', 'ro', { from: 'done' }), ...damagedEdges],
      );
    const damagedTo = (id: string) => edge('r', id, { from: 'damaged' });

    it('a path to a finish node without Render → RENDER_MISSING on the finish node; with Render → clean', () => {
      const bare = bareGraph(
        [
          node('in', 'core:input-manual'),
          node('kl', 'core:keep-languages'),
          node('ro', 'core:replace-original'),
        ],
        [edge('in', 'kl'), edge('kl', 'ro')],
      );
      expect(validateWorkflow(bare, ctx())).toEqual([
        {
          severity: 'error',
          code: 'RENDER_MISSING',
          message:
            'Put a Render step before Replace original: every path that reaches a finish step renders once',
          nodeId: 'ro',
        },
      ]);
      expect(validateWorkflow(rendered(false), ctx())).toEqual([]);
      expect(validateWorkflow(rendered(true), ctx())).toEqual([]);
    });

    it('two Renders in a row → RENDER_TWICE; Render on an output shared with Replace original → RENDER_SHARED_OUTPUT', () => {
      const twice = bareGraph(
        [
          node('in', 'core:input-manual'),
          node('r1', 'core:render'),
          node('r2', 'core:render', {}, { label: 'Second render' }),
          node('ro', 'core:replace-original'),
        ],
        [edge('in', 'r1'), edge('r1', 'r2', { from: 'done' }), edge('r2', 'ro', { from: 'done' })],
      );
      expect(validateWorkflow(twice, ctx())).toEqual([
        {
          severity: 'error',
          code: 'RENDER_TWICE',
          message: 'Second render comes after another Render; a path renders once',
          nodeId: 'r2',
        },
      ]);
      const shared = bareGraph(
        [
          node('in', 'core:input-manual'),
          node('r', 'core:render'),
          node('ro', 'core:replace-original'),
          node('nw', 'core:notify-webhook', { url: 'https://example.test/hook' }),
        ],
        [edge('in', 'r'), edge('in', 'ro'), edge('r', 'nw', { from: 'done' })],
      );
      expect(find(validateWorkflow(shared, ctx()), 'RENDER_SHARED_OUTPUT')).toEqual([
        {
          severity: 'error',
          code: 'RENDER_SHARED_OUTPUT',
          message:
            'Render must be the only step on this output; put the other steps after Render\u2019s Done or Damaged',
          nodeId: 'r',
          edgeId: 'in-r',
        },
      ]);
    });

    it('a bypassed Render → RENDER_BYPASSED', () => {
      const g = rendered(false);
      const bypassed = {
        ...g,
        nodes: g.nodes.map((n) => (n.id === 'r' ? { ...n, bypassed: true } : n)),
      };
      expect(validateWorkflow(bypassed, ctx())).toEqual([
        {
          severity: 'error',
          code: 'RENDER_BYPASSED',
          message: 'Render can\u2019t be skipped: the file is rendered here',
          nodeId: 'r',
        },
      ]);
    });

    it('an edge from Damaged while Quality check is off → PORT_HIDDEN with the edge id; on → clean', () => {
      const off = rendered(false, [notifyNode()], [damagedTo('nw')]);
      const issues = validateWorkflow(off, ctx());
      expect(find(issues, 'PORT_HIDDEN')).toEqual([
        {
          severity: 'error',
          code: 'PORT_HIDDEN',
          message:
            'Render: output "Damaged" is only there while Quality check is on; remove the connection or turn Quality check on',
          edgeId: 'r-nw',
        },
      ]);
      // never followed: the notify behind it is unreachable, not a path of its own
      expect(codes(issues)).toEqual(['error:PORT_HIDDEN', 'warning:NODE_UNREACHABLE']);
      expect(validateWorkflow(rendered(true, [notifyNode()], [damagedTo('nw')]), ctx())).toEqual(
        [],
      );
    });

    it('after Damaged: replace-original → DAMAGED_ONLY_NOTIFY; notify-webhook → clean; NO_WRITE_PATH is not warned below Damaged', () => {
      const bad = rendered(true, [node('rb', 'core:replace-original')], [damagedTo('rb')]);
      expect(validateWorkflow(bad, ctx())).toEqual([
        {
          severity: 'error',
          code: 'DAMAGED_ONLY_NOTIFY',
          message:
            'After Render\u2019s Damaged, only notifications and other non-writing finish steps can follow.',
          nodeId: 'rb',
        },
      ]);
      const gate = rendered(true, [node('sg', 'core:size-gate')], [damagedTo('sg')]);
      expect(
        find(validateWorkflow(gate, ctx()), 'DAMAGED_ONLY_NOTIFY').map((i) => i.nodeId),
      ).toEqual(['sg']);
      // a chain of notifications on Damaged never writes, and needs not
      const chained = rendered(
        true,
        [notifyNode('n1'), notifyNode('n2')],
        [damagedTo('n1'), edge('n1', 'n2')],
      );
      expect(validateWorkflow(chained, ctx())).toEqual([]);
    });

    it('a damagedOnly finish node (test registry stub "test:replace-damaged", phase library-manager) on Done → DAMAGED_ONLY; on Damaged → clean; chained after a notify on Damaged → clean', () => {
      const onDone = bareGraph(
        [
          node('in', 'core:input-manual'),
          node('r', 'core:render'),
          node('ro', 'core:replace-original'),
          node('rd', 'test:replace-damaged'),
        ],
        [edge('in', 'r'), edge('r', 'ro', { from: 'done' }), edge('ro', 'rd')],
      );
      expect(validateWorkflow(onDone, damagedCtx())).toEqual([
        {
          severity: 'error',
          code: 'DAMAGED_ONLY',
          message: 'Replace damaged file can only follow a Damaged output',
          nodeId: 'rd',
        },
      ]);
      const onDamaged = rendered(true, [node('rd', 'test:replace-damaged')], [damagedTo('rd')]);
      expect(validateWorkflow(onDamaged, damagedCtx())).toEqual([]);
      const afterNotify = rendered(
        true,
        [
          node('n0', 'core:notify-webhook', { url: 'https://example.test/hook' }),
          node('rd', 'test:replace-damaged'),
        ],
        [damagedTo('n0'), edge('n0', 'rd')],
      );
      // still below Damaged (its order is FINISH_ORDER's business: notify runs after library-manager)
      expect(find(validateWorkflow(afterNotify, damagedCtx()), 'DAMAGED_ONLY')).toEqual([]);
    });

    it('Render in a sub-workflow → NODE_NOT_ALLOWED_HERE', () => {
      const sub = chain('subworkflow', node('r', 'core:render'));
      expect(
        find(validateWorkflow(sub, ctx()), 'NODE_NOT_ALLOWED_HERE').map((i) => i.nodeId),
      ).toEqual(['r']);
    });

    describe('Check source', () => {
      /** in → cs; OK → `ok` (chained); Damaged → `damaged` (chained). */
      const checked = (ok: NodeInstance[], damaged: NodeInstance[], extraEdges: Edge[] = []) =>
        bareGraph(
          [node('in', 'core:input-manual'), node('cs', 'core:check-source'), ...ok, ...damaged],
          [
            edge('in', 'cs'),
            ...ok.map((n, i) => {
              if (i === 0) return edge('cs', n.id, { from: 'ok' });
              const prev = ok[i - 1] as NodeInstance;
              return edge(prev.id, n.id, prev.type === 'core:render' ? { from: 'done' } : {});
            }),
            ...damaged.map((n, i) =>
              i === 0
                ? edge('cs', n.id, { from: 'damaged' })
                : edge((damaged[i - 1] as NodeInstance).id, n.id),
            ),
            ...extraEdges,
          ],
        );
      const okSide = () => [node('r', 'core:render'), node('ro', 'core:replace-original')];

      it('after Check source’s Damaged a notify needs no Render and a replace-original is DAMAGED_ONLY_NOTIFY; after OK a Render is still required', () => {
        expect(validateWorkflow(checked(okSide(), [notifyNode('nd')]), ctx())).toEqual([]);
        // An unconnected Damaged is fine too: the original is kept as damaged.
        expect(validateWorkflow(checked(okSide(), []), ctx())).toEqual([]);
        expect(
          validateWorkflow(checked(okSide(), [node('rb', 'core:replace-original')]), ctx()),
        ).toEqual([
          {
            severity: 'error',
            code: 'DAMAGED_ONLY_NOTIFY',
            message:
              'After Check source\u2019s Damaged, only notifications and other non-writing finish steps can follow.',
            nodeId: 'rb',
          },
        ]);
        // No Render below Damaged (nothing is encoded there), and no action either.
        for (const below of [
          [node('r2', 'core:render'), notifyNode('nd')],
          [node('ev', 'core:encode-video', { codec: 'h264', encoder: 'libx264' })],
        ]) {
          expect(
            find(validateWorkflow(checked(okSide(), below), ctx()), 'DAMAGED_ONLY_NOTIFY').map(
              (i) => i.nodeId,
            ),
          ).toEqual([(below[0] as NodeInstance).id]);
        }
        const noRender = checked([node('ro', 'core:replace-original')], [notifyNode('nd')]);
        expect(
          find(validateWorkflow(noRender, ctx()), 'RENDER_MISSING').map((i) => i.nodeId),
        ).toEqual(['ro']);
      });

      it('a damagedOnly node may follow Check source’s Damaged, not OK', () => {
        const onDamaged = checked(okSide(), [node('rd', 'test:replace-damaged')]);
        expect(validateWorkflow(onDamaged, damagedCtx())).toEqual([]);
        const onOk = checked([...okSide(), node('rd', 'test:replace-damaged')], []);
        expect(
          find(validateWorkflow(onOk, damagedCtx()), 'DAMAGED_ONLY').map((i) => i.nodeId),
        ).toEqual(['rd']);
      });

      it('Check source’s Damaged and Render’s Damaged may both lead into one damagedOnly node; a path from Done into it is still DAMAGED_ONLY', () => {
        /** in → cs; OK → r → (Done) ro; r.damaged → rd; cs.damaged → rd. */
        const both = (extra: Edge[] = []) =>
          bareGraph(
            [
              node('in', 'core:input-manual'),
              node('cs', 'core:check-source'),
              node('r', 'core:render', { qualityCheck: true }),
              node('ro', 'core:replace-original'),
              node('rd', 'test:replace-damaged'),
            ],
            [
              edge('in', 'cs'),
              edge('cs', 'r', { from: 'ok' }),
              edge('r', 'ro', { from: 'done' }),
              edge('r', 'rd', { from: 'damaged' }),
              edge('cs', 'rd', { from: 'damaged' }),
              ...extra,
            ],
          );
        expect(validateWorkflow(both(), damagedCtx())).toEqual([]);
        const alsoFromDone = validateWorkflow(both([edge('ro', 'rd')]), damagedCtx());
        expect(codes(alsoFromDone)).toEqual(['error:DAMAGED_ONLY']);
        expect(alsoFromDone[0]).toMatchObject({ nodeId: 'rd' });
      });

      it('a shared node is checked per path: a path without Render into it → RENDER_MISSING, and an action reached after a finish node on one path → FINISH_ORDER', () => {
        // in → r → sg → ro, and in → ro: the second path skips Render
        const skipsRender = bareGraph(
          [
            node('in', 'core:input-manual'),
            node('sg', 'core:size-gate'),
            node('r', 'core:render'),
            node('ro', 'core:replace-original'),
          ],
          [
            edge('in', 'r'),
            edge('r', 'sg', { from: 'done' }),
            edge('sg', 'ro', { from: 'pass' }),
            edge('in', 'ro'),
          ],
        );
        expect(
          find(validateWorkflow(skipsRender, ctx()), 'RENDER_MISSING').map((i) => i.nodeId),
        ).toEqual(['ro']);
        // in → kl → r → ro → nw → kl2, and in → kl2: on the first path kl2 follows finish nodes
        const afterFinish = bareGraph(
          [
            node('in', 'core:input-manual'),
            node('kl', 'core:keep-languages'),
            node('r', 'core:render'),
            node('ro', 'core:replace-original'),
            notifyNode('nw'),
            node('kl2', 'core:keep-languages'),
          ],
          [
            edge('in', 'kl'),
            edge('kl', 'r'),
            edge('r', 'ro', { from: 'done' }),
            edge('ro', 'nw'),
            edge('nw', 'kl2'),
            edge('in', 'kl2'),
          ],
        );
        expect(
          find(validateWorkflow(afterFinish, ctx()), 'FINISH_ORDER').map((i) => i.nodeId),
        ).toEqual(['kl2']);
      });

      describe('NO_WRITE_PATH on a check-only branch', () => {
        /**
         * in → `gate`; its No (`else`) → kl → r → sg → ro; its Yes (`pass`) → cs; cs Damaged →
         * rd unless `damaged` is false, cs OK → `ok` when given.
         */
        const checkOnly = (
          gate: NodeInstance,
          opts: { damaged?: boolean; ok?: NodeInstance } = {},
        ) =>
          bareGraph(
            [
              node('in', 'core:input-manual'),
              gate,
              node('kl', 'core:keep-languages'),
              node('r', 'core:render'),
              node('sg', 'core:size-gate'),
              node('ro', 'core:replace-original'),
              node('cs', 'core:check-source', { decodeVideo: true }),
              node('rd', 'test:replace-damaged'),
              ...(opts.ok ? [opts.ok] : []),
            ],
            [
              edge('in', gate.id),
              edge(gate.id, 'kl', { from: 'else' }),
              edge('kl', 'r'),
              edge('r', 'sg', { from: 'done' }),
              edge('sg', 'ro', { from: 'pass' }),
              edge(gate.id, 'cs', { from: 'pass' }),
              ...(opts.damaged === false ? [] : [edge('cs', 'rd', { from: 'damaged' })]),
              ...(opts.ok ? [edge('cs', opts.ok.id, { from: 'ok' })] : []),
            ],
          );
        const processed = (bypassed = false) =>
          node('ap', 'core:already-processed', {}, bypassed ? { bypassed } : {});
        const noWrite = (g: WorkflowGraph) =>
          find(validateWorkflow(g, damagedCtx()), 'NO_WRITE_PATH').map((i) => i.nodeId);

        it('Already processed’s Yes → Check source, Damaged wired and OK open, is clean', () => {
          expect(validateWorkflow(checkOnly(processed()), damagedCtx())).toEqual([]);
        });

        it('below Already processed’s Yes nothing needs a write: Check source with both outputs open, or an action after OK, is clean too', () => {
          expect(noWrite(checkOnly(processed(), { damaged: false }))).toEqual([]);
          const ok = node('k2', 'core:keep-languages');
          expect(noWrite(checkOnly(processed(), { damaged: false, ok }))).toEqual([]);
        });

        it('an open OK beside a wired Damaged is clean below any condition', () => {
          expect(noWrite(checkOnly(node('vi', 'core:video-is')))).toEqual([]);
        });

        it('still warned: every output open below another condition’s Yes, a lone action below Already processed’s No, a bypassed Already processed', () => {
          // video-is Yes → Check source with nothing wired: the path ends on cs without a write
          expect(noWrite(checkOnly(node('vi', 'core:video-is'), { damaged: false }))).toEqual([
            'cs',
          ]);
          // Already processed's No → kl with nothing after it
          const onNo = bareGraph(
            [
              node('in', 'core:input-manual'),
              processed(),
              node('kl', 'core:keep-languages'),
              node('r', 'core:render'),
              node('ro', 'core:replace-original'),
            ],
            [
              edge('in', 'ap'),
              edge('ap', 'r', { from: 'pass' }),
              edge('r', 'ro', { from: 'done' }),
              edge('ap', 'kl', { from: 'else' }),
            ],
          );
          expect(noWrite(onNo)).toEqual(['kl']);
          // A bypassed Already processed checks nothing: every file goes on by its Yes
          expect(noWrite(checkOnly(processed(true), { damaged: false }))).toEqual(['cs']);
        });
      });

      it('Check source in a sub-workflow → NODE_NOT_ALLOWED_HERE', () => {
        const sub = chain('subworkflow', node('cs', 'core:check-source'));
        expect(
          find(validateWorkflow(sub, ctx()), 'NODE_NOT_ALLOWED_HERE').map((i) => i.nodeId),
        ).toEqual(['cs']);
      });
    });
  });
});
