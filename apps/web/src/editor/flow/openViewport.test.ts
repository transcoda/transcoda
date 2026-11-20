import { describe, expect, it } from 'vitest';
import { openViewport, READABLE_ZOOM } from './openViewport.ts';

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
