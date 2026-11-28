import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { stylesCss } from '../../styles/testing/css-source.ts';
import { renderFlow } from '../../testing/flow.tsx';
import { iconScale, TRACE_ICON, useZoomLevel } from './use-zoom-level.ts';

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

describe('iconScale on the job page trace', () => {
  it('leaves the editor alone and only changes the icon level', () => {
    expect(iconScale(0.33, 'icon', false)).toBe(iconScale(0.33, 'icon'));
    expect(iconScale(0.5, 'compact', true)).toBe(iconScale(0.5, 'compact'));
    expect(iconScale(1, 'full', true)).toBe(1);
  });

  it('draws a glyph of about 30 px on screen at a typical fit, in a circle twice the editor size', () => {
    const scale = iconScale(0.33, 'icon', true);
    expect(28 * scale * 0.33).toBeGreaterThanOrEqual(28);
    expect(28 * scale * 0.33).toBeLessThanOrEqual(34);
    expect(TRACE_ICON.circle * 0.33).toBeGreaterThanOrEqual(48);
    expect(TRACE_ICON.circle).toBe(2 * 80);
  });

  it('keeps the scaled glyph inside the circle at every icon-level zoom', () => {
    for (const zoom of [0.39, 0.3, 0.2, 0.1]) {
      expect(28 * iconScale(zoom, 'icon', true)).toBeLessThanOrEqual(TRACE_ICON.circle * 0.65);
    }
  });

  it('the stylesheet sizes the trace tile to match', () => {
    const css = stylesCss;
    expect(css).toMatch(
      new RegExp(
        `\\.tc-node\\.zoom-icon\\.is-big-icon \\{[^}]*width: ${TRACE_ICON.circle}px;[^}]*height: ${TRACE_ICON.circle}px;`,
      ),
    );
  });
});
