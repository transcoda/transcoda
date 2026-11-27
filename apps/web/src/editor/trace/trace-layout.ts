import type { TcFlowNode } from '../flow/types.ts';
import { GROUP_PADDING } from '../model/graph-ops.ts';

type FlowNode = TcFlowNode;

/** Room kept between two cards of one column that the trace view had to move apart. */
export const CARD_GAP = 24;

type Box = { node: FlowNode; x: number; y: number; width: number; height: number };

const sameColumn = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width;
const overlaps = (a: Box, b: Box): boolean =>
  sameColumn(a, b) && a.y < b.y + b.height && b.y < a.y + a.height;
const isData = (n: FlowNode): boolean => n.type === 'tc-node' && n.data.def?.kind === 'data';

/**
 * The trace canvas's card positions once the cards are measured (#36). A job's cards are taller
 * than the editor's (each reached node has its trace row), so cards the editor stacked in one
 * column can cover each other. Every other card keeps its place unless a card above it in its
 * column grew over it, then it moves down below that card. A data node is a side input: it gets
 * its own offset instead of moving the main row, moving up clear of the card below it (or down,
 * when it sits below the card it collides with). Only visible, measured top-level cards take part;
 * a group's members keep their positions inside the group. Returns `nodes` itself when nothing
 * moves.
 */
export function spreadCards<N extends FlowNode>(nodes: N[], gap = CARD_GAP): N[] {
  const boxes: Box[] = [];
  for (const node of nodes) {
    const width = node.measured?.width;
    const height = node.measured?.height;
    if (node.parentId !== undefined || node.hidden || !width || !height) continue;
    boxes.push({ node, x: node.position.x, y: node.position.y, width, height });
  }
  const byTop = (a: Box, b: Box) => a.y - b.y || a.x - b.x;
  const placed: Box[] = [];
  const moved = new Map<string, number>();
  const settle = (box: Box, step: (other: Box) => number): void => {
    for (let hit = placed.find((p) => overlaps(p, box)); hit; ) {
      box.y = step(hit);
      hit = placed.find((p) => overlaps(p, box));
    }
    if (box.y !== box.node.position.y) moved.set(box.node.id, box.y);
    placed.push(box);
  };

  // The main cards, top to bottom: a card covered by one above it moves below it.
  for (const box of boxes.filter((b) => !isData(b.node)).sort(byTop)) {
    settle(box, (p) => p.y + p.height + gap);
  }
  // Data cards with a main card below them in their column move up (nearest first) …
  const data = boxes.filter((b) => isData(b.node));
  const above = (d: Box) => placed.some((p) => sameColumn(p, d) && p.y > d.y);
  const up = data.filter(above);
  for (const box of up.sort((a, b) => b.y - a.y)) settle(box, (p) => p.y - gap - box.height);
  // … the rest move down below what covers them.
  for (const box of data.filter((d) => !up.includes(d)).sort(byTop)) {
    settle(box, (p) => p.y + p.height + gap);
  }

  if (moved.size === 0) return nodes;
  return nodes.map((n) => {
    const y = moved.get(n.id);
    return y === undefined ? n : { ...n, position: { x: n.position.x, y } };
  });
}

type Member = { node: FlowNode; x: number; y: number; width: number; height: number };

/**
 * The factor the members' offsets inside a group are scaled by so that no two measured members
 * cover each other (at least 1): for each covering pair, the smaller of the stretches that clears
 * them sideways or downwards by `gap`. A pair on the very same spot cannot be cleared by scaling
 * and is left out.
 */
function memberScale(members: Member[], gap: number): number {
  let scale = 1;
  for (const [i, a] of members.entries()) {
    for (const b of members.slice(i + 1)) {
      const [left, right] = a.x <= b.x ? [a, b] : [b, a];
      const [top, bottom] = a.y <= b.y ? [a, b] : [b, a];
      if (right.x >= left.x + left.width || bottom.y >= top.y + top.height) continue;
      const dx = right.x - left.x;
      const dy = bottom.y - top.y;
      const need = Math.min(
        dx > 0 ? (left.width + gap) / dx : Number.POSITIVE_INFINITY,
        dy > 0 ? (top.height + gap) / dy : Number.POSITIVE_INFINITY,
      );
      if (Number.isFinite(need)) scale = Math.max(scale, need);
    }
  }
  return scale;
}

/**
 * The trace canvas's member positions inside each expanded group once the members are measured.
 * The editor's saved offsets are made for its own cards; the job page's are larger (the trace
 * rows, and the 160 px icon tiles when zoomed out), so members can cover each other. Their offsets
 * from the group's first member are stretched by one factor (`memberScale`), which keeps the
 * group's arrangement, and the group grows to hold them with `GROUP_PADDING` to spare (never
 * shrinks). View state only: the graph's saved positions are not touched. Returns `nodes` itself
 * when nothing changes.
 */
export function spreadMembers<N extends FlowNode>(nodes: N[], gap = CARD_GAP): N[] {
  const byGroup = new Map<string, Member[]>();
  for (const node of nodes) {
    const width = node.measured?.width;
    const height = node.measured?.height;
    if (node.parentId === undefined || node.hidden || !width || !height) continue;
    const list = byGroup.get(node.parentId) ?? [];
    list.push({ node, x: node.position.x, y: node.position.y, width, height });
    byGroup.set(node.parentId, list);
  }
  const positions = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string, { width: number; height: number }>();
  for (const [groupId, members] of byGroup) {
    const group = nodes.find((n) => n.id === groupId);
    if (!group) continue;
    const scale = memberScale(members, gap);
    const minX = Math.min(...members.map((m) => m.x));
    const minY = Math.min(...members.map((m) => m.y));
    let right = 0;
    let bottom = 0;
    for (const m of members) {
      const x = minX + (m.x - minX) * scale;
      const y = minY + (m.y - minY) * scale;
      if (x !== m.x || y !== m.y) positions.set(m.node.id, { x, y });
      right = Math.max(right, x + m.width + GROUP_PADDING);
      bottom = Math.max(bottom, y + m.height + GROUP_PADDING);
    }
    const width = Number(group.style?.width ?? group.measured?.width ?? 0);
    const height = Number(group.style?.height ?? group.measured?.height ?? 0);
    if (right > width || bottom > height) {
      sizes.set(groupId, { width: Math.max(width, right), height: Math.max(height, bottom) });
    }
  }

  if (positions.size === 0 && sizes.size === 0) return nodes;
  return nodes.map((n) => {
    const position = positions.get(n.id);
    if (position) return { ...n, position };
    const size = sizes.get(n.id);
    return size ? { ...n, style: { ...n.style, ...size }, measured: size } : n;
  });
}
