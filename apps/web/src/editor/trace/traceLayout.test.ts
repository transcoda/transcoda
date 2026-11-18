import { describe, expect, it } from 'vitest';
import type { TcGroupNode, TcNode } from '../flow/types.ts';
import { GROUP_PADDING } from '../model/graph-ops.ts';
import { CARD_GAP, spreadCards, spreadMembers } from './traceLayout.ts';

type Spec = { id: string; x: number; y: number; h: number; kind?: string; parentId?: string };

function card({ id, x, y, h, kind = 'action', parentId }: Spec): TcNode {
  return {
    id,
    type: 'tc-node',
    position: { x, y },
    measured: { width: 210, height: h },
    ...(parentId && { parentId }),
    data: { def: { kind } } as unknown as TcNode['data'],
  };
}

const ys = (nodes: Array<TcNode | TcGroupNode>) =>
  Object.fromEntries(nodes.map((n) => [n.id, n.position.y]));

describe('spreadCards (the trace canvas: cards grown by their trace rows never overlap, #36)', () => {
  it('moves a data card above a taller-grown card up, so the main row stays put', () => {
    // "Original language (Radarr)" at y -160 over "Keep languages" at y 0; with its trace row the
    // data card is 190 high and would cover the card below.
    const nodes = [
      card({ id: 'input', x: 0, y: 0, h: 150, kind: 'trigger' }),
      card({ id: 'orig', x: 240, y: -160, h: 190, kind: 'data' }),
      card({ id: 'languages', x: 240, y: 0, h: 220 }),
      card({ id: 'defaults', x: 480, y: 0, h: 180 }),
    ];
    expect(ys(spreadCards(nodes))).toEqual({
      input: 0,
      orig: -190 - CARD_GAP,
      languages: 0,
      defaults: 0,
    });
  });

  it('pushes a card down below a grown card above it in the same column (not a data card)', () => {
    const nodes = [
      card({ id: 'rescan', x: 1440, y: -160, h: 200, kind: 'finish' }),
      card({ id: 'refresh', x: 1440, y: 0, h: 200, kind: 'finish' }),
      card({ id: 'notify', x: 1440, y: 160, h: 120, kind: 'finish' }),
    ];
    expect(ys(spreadCards(nodes))).toEqual({
      rescan: -160,
      refresh: 40 + CARD_GAP,
      notify: 40 + CARD_GAP + 200 + CARD_GAP,
    });
  });

  it('moves a data card below a grown card down', () => {
    const nodes = [
      card({ id: 'languages', x: 240, y: 0, h: 220 }),
      card({ id: 'orig', x: 240, y: 160, h: 120, kind: 'data' }),
    ];
    expect(ys(spreadCards(nodes))).toEqual({ languages: 0, orig: 220 + CARD_GAP });
  });

  it('stacks two data cards above one card', () => {
    const nodes = [
      card({ id: 'a', x: 240, y: -320, h: 150, kind: 'data' }),
      card({ id: 'b', x: 240, y: -160, h: 190, kind: 'data' }),
      card({ id: 'main', x: 240, y: 0, h: 150 }),
    ];
    const out = ys(spreadCards(nodes));
    expect(out.main).toBe(0);
    expect(out.b).toBe(-190 - CARD_GAP);
    expect(out.a).toBe(-190 - CARD_GAP - CARD_GAP - 150);
  });

  it('leaves cards that do not overlap, cards in other columns, unmeasured cards and group members alone', () => {
    const unmeasured = card({ id: 'u', x: 240, y: 10, h: 0 });
    delete unmeasured.measured;
    const nodes = [
      card({ id: 'a', x: 0, y: 0, h: 120 }),
      card({ id: 'b', x: 0, y: 160, h: 120 }),
      card({ id: 'c', x: 240, y: 0, h: 400 }),
      unmeasured,
      card({ id: 'm1', x: 10, y: 10, h: 300, parentId: 'g' }),
      card({ id: 'm2', x: 10, y: 50, h: 100, parentId: 'g' }),
    ];
    expect(ys(spreadCards(nodes))).toEqual({ a: 0, b: 160, c: 0, u: 10, m1: 10, m2: 50 });
  });

  it('returns the same array when nothing moves (no new positions on a quiet update)', () => {
    const nodes = [card({ id: 'a', x: 0, y: 0, h: 120 }), card({ id: 'b', x: 0, y: 160, h: 120 })];
    expect(spreadCards(nodes)).toBe(nodes);
  });
});

function group(id: string, width: number, height: number): TcGroupNode {
  return {
    id,
    type: 'tc-group',
    position: { x: 0, y: 0 },
    style: { width, height },
    measured: { width, height },
    data: {} as TcGroupNode['data'],
  };
}

/** A member drawn as the job page's 160 px icon tile. */
function tile(id: string, x: number, y: number): TcNode {
  return { ...card({ id, x, y, h: 160, parentId: 'g' }), measured: { width: 160, height: 160 } };
}

describe('spreadMembers (the trace canvas: the members of an expanded group never cover each other)', () => {
  it('stretches 160 px icon tiles saved 120 apart in one column until they clear, and grows the group', () => {
    const nodes = [group('g', 258, 312), tile('m1', 24, 24), tile('m2', 24, 144)];
    const out = spreadMembers(nodes);
    const m1 = out.find((n) => n.id === 'm1');
    const m2 = out.find((n) => n.id === 'm2');
    const g = out.find((n) => n.id === 'g');
    expect(m1?.position).toEqual({ x: 24, y: 24 });
    expect(m2?.position).toEqual({ x: 24, y: 24 + 160 + CARD_GAP });
    expect(g?.style).toMatchObject({ height: 24 + 160 + CARD_GAP + 160 + GROUP_PADDING });
    expect(g?.measured?.height).toBe(24 + 160 + CARD_GAP + 160 + GROUP_PADDING);
    expect(g?.style).toMatchObject({ width: 258 });
  });

  it('stretches a row and a column by one factor, keeping the arrangement', () => {
    const nodes = [group('g', 600, 400), tile('a', 24, 24), tile('b', 144, 24), tile('c', 24, 124)];
    const out = Object.fromEntries(spreadMembers(nodes).map((n) => [n.id, n.position]));
    // b is 120 to the side (needs 184/120), c 100 below (needs 184/100): the larger wins.
    const s = (160 + CARD_GAP) / 100;
    expect(out.b).toEqual({ x: 24 + 120 * s, y: 24 });
    expect(out.c).toEqual({ x: 24, y: 24 + 100 * s });
  });

  it('leaves members that already clear each other, and the group, alone (the same array)', () => {
    const nodes = [group('g', 600, 400), card({ id: 'a', x: 24, y: 24, h: 120, parentId: 'g' })];
    nodes.push(card({ id: 'b', x: 264, y: 24, h: 120, parentId: 'g' }));
    expect(spreadMembers(nodes)).toBe(nodes);
  });

  it('skips hidden (collapsed) and unmeasured members', () => {
    const hidden = { ...tile('a', 24, 24), hidden: true };
    const unmeasured = tile('b', 24, 64);
    delete unmeasured.measured;
    const nodes = [group('g', 80, 80), hidden, unmeasured];
    expect(spreadMembers(nodes)).toBe(nodes);
  });
});
