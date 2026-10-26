import type { TcFlowNode } from '../flow/types.ts';

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
