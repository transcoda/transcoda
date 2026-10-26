import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderFlow } from '../../test/flow.tsx';
import { iconScale, useZoomLevel } from './useZoomLevel.ts';

afterEach(cleanup);

function Probe() {
  return <output>{useZoomLevel()}</output>;
}

describe('useZoomLevel', () => {
  it.each([
    [1, 'full'],
    [0.75, 'full'],
    [0.5, 'compact'],
    [0.4, 'compact'],
    [0.3, 'icon'],
  ])('maps zoom %s to %s', async (zoom, level) => {
    // React Flow clamps the viewport to minZoom (0.5 by default).
    await renderFlow([], [], {
      defaultViewport: { x: 0, y: 0, zoom },
      minZoom: 0.1,
      children: <Probe />,
    });
    expect(screen.getByRole('status').textContent).toBe(level);
  });
});

describe('iconScale', () => {
  it('leaves the full card alone', () => {
    expect(iconScale(1, 'full')).toBe(1);
    expect(iconScale(0.75, 'full')).toBe(1);
  });

  it('grows icons as the canvas zooms out, in quarter steps, never past 2x (1.75x in the circle)', () => {
    expect(iconScale(0.5, 'compact')).toBe(1.5);
    expect(iconScale(0.4, 'compact')).toBe(1.75);
    expect(iconScale(0.39, 'icon')).toBe(1.5);
    expect(iconScale(0.2, 'icon')).toBe(1.75);
    expect(iconScale(0.1, 'icon')).toBe(1.75);
  });

  it('keeps the icon at least 16 px on screen at the icon level down to 0.36 zoom', () => {
    for (const zoom of [0.39, 0.38, 0.37, 0.36]) {
      expect(28 * iconScale(zoom, 'icon') * zoom).toBeGreaterThanOrEqual(15.5);
    }
  });

  it('fits the scaled glyph inside the 80 px circle with room around it', () => {
    for (const zoom of [0.39, 0.3, 0.2, 0.1]) {
      expect(28 * iconScale(zoom, 'icon')).toBeLessThanOrEqual(49);
    }
  });
});
