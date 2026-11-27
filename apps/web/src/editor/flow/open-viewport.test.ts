import { describe, expect, it } from 'vitest';
import {
  fitPadding,
  fitPaddingPx,
  openBounds,
  openViewport,
  READABLE_ZOOM,
} from './open-viewport.ts';

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const pane = { width: 1200, height: 800 };
const trigger = rect(0, 100, 300, 120);

describe('openViewport (the zoom and position a canvas opens at)', () => {
  it('opens on the whole graph when that is readable', () => {
    const v = openViewport(rect(0, 0, 900, 400), trigger, pane);
    expect(v.zoom).toBeGreaterThanOrEqual(READABLE_ZOOM);
    expect(v.zoom).toBeLessThanOrEqual(1);
    // Centred: the same room left of the graph as right of it.
    expect(v.x).toBeCloseTo((pane.width - 900 * v.zoom) / 2, 5);
  });

  it('never blows a small graph up past 100 %', () => {
    expect(openViewport(rect(0, 0, 300, 120), trigger, pane).zoom).toBe(1);
  });

  it('a graph too wide to read whole opens at the readable zoom with the trigger at the left', () => {
    const v = openViewport(rect(0, 0, 4000, 400), trigger, pane);
    expect(v.zoom).toBe(READABLE_ZOOM);
    expect(trigger.x * v.zoom + v.x).toBe(48);
    // The graph's height fits at that zoom, so it is centred vertically.
    expect(200 * v.zoom + v.y).toBeCloseTo(pane.height / 2, 5);
  });

  it('a graph too tall as well is centred on the trigger', () => {
    const tall = rect(-200, -900, 4000, 2400);
    const v = openViewport(tall, rect(-200, 300, 300, 100), pane);
    expect(v.zoom).toBe(READABLE_ZOOM);
    expect(-200 * v.zoom + v.x).toBe(48);
    expect(350 * v.zoom + v.y).toBeCloseTo(pane.height / 2, 5);
  });

  it('takes its floor and fit options from the caller', () => {
    const v = openViewport(rect(0, 0, 4000, 400), trigger, pane, { floor: 0.2 });
    expect(v.zoom).toBeGreaterThan(0.2);
    expect(v.zoom).toBeLessThan(READABLE_ZOOM);
  });
});

describe('fit padding (React Flow 12 read a plain number as a share of the pane, 13 as pixels)', () => {
  it('fitPaddingPx is the per-side room React Flow 12 left: the graph gets 1 / (1 + p) of the pane', () => {
    expect(fitPaddingPx(0.2, 1200, 800)).toEqual({ x: 100, y: 66 });
    expect(fitPaddingPx(0.25, 1000, 800)).toEqual({ x: 100, y: 80 });
    expect(fitPaddingPx(0, 1200, 800)).toEqual({ x: 0, y: 0 });
  });

  it('fitPadding is the same share as a percentage per side', () => {
    expect(fitPadding(0.2)).toMatch(/^8\.33+\d*%$/);
    expect(Number.parseFloat(fitPadding(0.1))).toBeCloseTo(4.545, 3);
    expect(Number.parseFloat(fitPadding(0.2)) * 12).toBeCloseTo(100, 6);
  });

  it('openViewport fits as React Flow 12 did: 0.2 leaves 100 px each side of a 1200 px pane', () => {
    // 1000 px of room for a 900 px wide graph (not the whole 1200 px).
    const v = openViewport(rect(0, 0, 900, 400), trigger, pane, { maxZoom: 2 });
    expect(v.zoom).toBeCloseTo(1000 / 900, 10);
    expect(v.x).toBeCloseTo(100, 6);
  });
});

describe('openBounds (the rectangle the first view fits)', () => {
  it('is null for an empty canvas', () => {
    expect(openBounds([])).toBeNull();
  });

  it('includes a group member that sits past its group, at its absolute position', () => {
    const boxes = [
      { id: 'trigger', x: 0, y: 0, width: 210, height: 120 },
      { id: 'group', x: 300, y: 0, width: 400, height: 300 },
      // Parent-relative: absolute x 300 + 500 = 800, right edge 1010, past the group's 700.
      { id: 'member', parentId: 'group', x: 500, y: 250, width: 210, height: 120 },
    ];
    expect(openBounds(boxes)).toEqual({ x: 0, y: 0, width: 1010, height: 370 });
  });

  it('the whole graph fits at a readable zoom, so the far member is in the first view', () => {
    const bounds = openBounds([
      { id: 'trigger', x: 0, y: 0, width: 210, height: 120 },
      { id: 'group', x: 300, y: 0, width: 400, height: 300 },
      { id: 'member', parentId: 'group', x: 500, y: 250, width: 210, height: 120 },
    ]);
    if (!bounds) throw new Error('no bounds');
    const v = openViewport(bounds, rect(0, 0, 210, 120), pane);
    expect(v.zoom).toBeGreaterThanOrEqual(READABLE_ZOOM);
    // The member's right and bottom edges land inside the pane.
    expect(1010 * v.zoom + v.x).toBeLessThanOrEqual(pane.width);
    expect(370 * v.zoom + v.y).toBeLessThanOrEqual(pane.height);
  });

  it('resolves nested parents and ignores a missing one', () => {
    expect(
      openBounds([
        { id: 'outer', x: 100, y: 100, width: 50, height: 50 },
        { id: 'inner', parentId: 'outer', x: 10, y: 10, width: 20, height: 20 },
        { id: 'leaf', parentId: 'inner', x: 5, y: 5, width: 10, height: 10 },
        { id: 'stray', parentId: 'gone', x: 0, y: 0, width: 10, height: 10 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 150, height: 150 });
  });
});
