import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderFlow } from '../../test/flow.tsx';
import { ZoomVar } from './ZoomVar.tsx';

afterEach(cleanup);

describe('ZoomVar', () => {
  it('writes the canvas zoom to --tc-zoom on the React Flow wrapper', async () => {
    const { container } = await renderFlow([], [], {
      defaultViewport: { x: 0, y: 0, zoom: 0.5 },
      minZoom: 0.1,
      children: <ZoomVar />,
    });
    const wrapper = container.querySelector<HTMLElement>('.react-flow');
    expect(wrapper?.style.getPropertyValue('--tc-zoom')).toBe('0.5');
  });
});
