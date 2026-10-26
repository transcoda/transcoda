import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkflowGraph } from '@transcoda/shared';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { PATH, RUNNING_TRACE, TRACE, traceMain, traceSub } from '../../test/fixtures/trace.ts';
import { fitTrace, type NodeRef, TraceCanvas } from './TraceCanvas.tsx';
import type { TraceSource } from './traceOverlay.ts';

afterEach(cleanup);

const card = (id: string, scope: HTMLElement = document.body) =>
  within(scope).getByTestId(`tc-node-${id}`);

function Harness({
  source,
  subgraphs = new Map(),
  names,
  paused,
  progress,
  onSelect = () => {},
}: {
  source: TraceSource;
  subgraphs?: ReadonlyMap<string, WorkflowGraph | null>;
  names?: ReadonlyMap<string, string>;
  paused?: boolean;
  progress?: number | null;
  onSelect?(ref: NodeRef | null): void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  return (
    <div style={{ width: 1200, height: 800 }}>
      <TraceCanvas
        graph={traceMain()}
        source={source}
        catalog={catalogFixture}
        selected={null}
        onSelect={onSelect}
        expanded={expanded}
        onExpand={setExpanded}
        subgraphs={subgraphs}
        {...(names && { names })}
        {...(paused !== undefined && { paused })}
        activity="Building"
        {...(progress !== undefined && { progress })}
      />
    </div>
  );
}

async function show(props: Parameters<typeof Harness>[0]) {
  const result = render(<Harness {...props} />);
  await act(async () => {});
  return result;
}

describe('TraceCanvas', () => {
  it('renders the current node with the running class and done nodes with their reason row; "Yes" is lit on Video is', async () => {
    const onSelect = vi.fn();
    await show({
      source: { trace: RUNNING_TRACE, steps: PATH, jobState: 'building', currentNode: undefined },
      onSelect,
    });
    const ca = card('ca');
    expect(ca.classList.contains('is-running')).toBe(true);
    expect(ca.getAttribute('aria-label')).toMatch(/, running$/);
    expect(within(ca).getByText('Building')).toBeTruthy();
    expect(within(card('vi')).getByText('already HEVC ≤ 8 Mb/s')).toBeTruthy();
    const pass = within(card('vi')).getByText('Yes');
    expect(pass.classList.contains('is-taken')).toBe(true);
    expect(within(card('vi')).getByText('No').classList.contains('is-dimmed')).toBe(true);
    // Read-only: no "+" connect buttons, no toolbar.
    expect(screen.queryByRole('button', { name: /Connect from/ })).toBeNull();
    expect(screen.queryByRole('toolbar')).toBeNull();
    // The else branch is out of reach but the job still runs: not dimmed yet.
    expect(card('ev').classList.contains('is-untaken')).toBe(false);
    fireEvent.click(card('vi'));
    expect(onSelect).toHaveBeenCalledWith({ workflowPath: [], nodeId: 'vi' });
  });

  describe('progress fill (the running node as the bar)', () => {
    const running = {
      trace: RUNNING_TRACE,
      steps: PATH,
      jobState: 'building' as const,
      currentNode: undefined,
    };

    it('fills the running node in proportion to progress, and no other node', async () => {
      await show({ source: running, progress: 42 });
      const fill = card('ca').querySelector<HTMLElement>('.tc-node-fill');
      expect(fill).not.toBeNull();
      expect(card('ca').style.getPropertyValue('--tc-progress')).toBe('42%');
      expect(card('ca').getAttribute('aria-label')).toMatch(/, running 42%$/);
      expect(fill?.getAttribute('aria-hidden')).toBe('true');
      // The inverted copy carries the same words, no handles or buttons.
      expect(fill?.textContent).toContain('Building');
      expect(fill?.querySelector('.react-flow__handle, button')).toBeNull();
      expect(card('vi').querySelector('.tc-node-fill')).toBeNull();
    });

    it('clamps to 0-100', async () => {
      await show({ source: running, progress: 140 });
      expect(card('ca').style.getPropertyValue('--tc-progress')).toBe('100%');
    });

    it('draws no fill without progress (null or none)', async () => {
      await show({ source: running, progress: null });
      expect(card('ca').querySelector('.tc-node-fill')).toBeNull();
      expect(card('ca').getAttribute('aria-label')).toMatch(/, running$/);
      cleanup();
      await show({ source: running });
      expect(card('ca').querySelector('.tc-node-fill')).toBeNull();
    });

    it('draws no fill once the job is final', async () => {
      await show({
        source: { trace: TRACE, steps: PATH, jobState: 'done', currentNode: undefined },
        progress: 100,
      });
      expect(document.querySelector('.tc-node-fill')).toBeNull();
    });

    it('css: inverted text on the lime fill (AA via --on-accent), motion only when allowed', () => {
      const css = readFileSync(join(__dirname, '../../styles.css'), 'utf8');
      const rule = css.match(/\.tc-node \.tc-node-fill\s*\{([^}]*)\}/)?.[1] ?? '';
      expect(rule).toMatch(/background:\s*var\(--accent\)/);
      expect(rule).toMatch(/color:\s*var\(--on-accent\)/);
      expect(rule).toMatch(/clip-path:\s*inset\(0 calc\(100% - var\(--tc-progress\)\) 0 0\)/);
      expect(rule).not.toMatch(/transition/);
      expect(css).toMatch(
        /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.tc-node \.tc-node-fill\s*\{[^}]*transition:/,
      );
    });
  });

  it('dims untaken nodes and marks taken edges once the job is final', async () => {
    const { container } = await show({
      source: { trace: TRACE, steps: PATH, jobState: 'done', currentNode: undefined },
    });
    expect(card('ev').classList.contains('is-untaken')).toBe(true);
    expect(card('ca').classList.contains('is-running')).toBe(false);
    const taken = container.querySelectorAll('.react-flow__edge-path.edge-path');
    const untaken = container.querySelectorAll('.react-flow__edge-path.edge-untaken');
    expect(taken.length).toBe(5);
    expect(untaken.length).toBe(3);
  });

  it('expanding the Run node renders the child canvas with the override tr visible in the reason', async () => {
    await show({
      source: { trace: TRACE, steps: PATH, jobState: 'done', currentNode: undefined },
      subgraphs: new Map([['run-a', traceSub()]]),
    });
    // run-b was never entered: only run-a can be opened.
    const open = screen.getByRole('button', { name: 'Expand sub-workflow Run sub-workflow' });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('tc-node-keep')).toBeNull();
    fireEvent.click(open);
    await act(async () => {});
    expect(open.getAttribute('aria-expanded')).toBe('true');
    const child = screen.getByRole('region', { name: 'Inside Run sub-workflow' });
    expect(
      within(card('keep', child)).getByText('kept en, de, tr, original, untagged'),
    ).toBeTruthy();
    fireEvent.click(open);
    await act(async () => {});
    expect(screen.queryByRole('region', { name: 'Inside Run sub-workflow' })).toBeNull();
  });

  it("titles the child canvas with the sub-workflow's name when the Run node has no label", async () => {
    await show({
      source: { trace: TRACE, steps: PATH, jobState: 'done', currentNode: undefined },
      subgraphs: new Map([['run-a', traceSub()]]),
      names: new Map([['run-a', 'Language cleanup']]),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Expand sub-workflow Run sub-workflow' }));
    await act(async () => {});
    expect(screen.getByRole('region', { name: 'Inside Language cleanup' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Inside Language cleanup' })).toBeTruthy();
  });

  it('a paused job keeps its node current but still (no moving border) and says paused', async () => {
    await show({
      source: { trace: RUNNING_TRACE, steps: PATH, jobState: 'building', currentNode: undefined },
      paused: true,
    });
    const ca = card('ca');
    expect(ca.classList.contains('is-running')).toBe(true);
    expect(ca.classList.contains('is-paused')).toBe(true);
    expect(ca.getAttribute('aria-label')).toMatch(/, paused$/);
  });

  it('says so when the sub-workflow version cannot be read', async () => {
    await show({
      source: { trace: TRACE, steps: PATH, jobState: 'done', currentNode: undefined },
      subgraphs: new Map([['run-a', null]]),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Expand sub-workflow Run sub-workflow' }));
    await act(async () => {});
    expect(screen.getByText('This sub-workflow version can no longer be read.')).toBeTruthy();
  });

  it('shows no React Flow attribution link on the job page', async () => {
    const { container } = await show({
      source: { trace: TRACE, steps: PATH, jobState: 'done', currentNode: undefined },
    });
    expect(container.querySelector('.react-flow__attribution')).toBeNull();
  });
});

describe('fitTrace', () => {
  const bounds = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

  it('fits the whole width: zoom from the pane, height from the graph, nothing cut', () => {
    // 1000 px of content in a 1100 px pane (24 px each side): zoom 1052/1000 → capped at 1.
    const wide = fitTrace(bounds(0, 0, 2000, 300), 1100);
    expect(wide.viewport.zoom).toBeCloseTo((1100 - 48) / 2000, 5);
    // The last node's right edge lands inside the pane, with the left pad kept.
    expect(wide.viewport.x).toBeCloseTo(24, 5);
    expect(2000 * wide.viewport.zoom + wide.viewport.x).toBeLessThanOrEqual(1100 - 24 + 1e-6);
    // The graph's height fits with a pad above and room below for the zoom controls.
    expect(wide.viewport.y).toBeCloseTo(24, 5);
    expect(wide.height).toBeGreaterThanOrEqual(300 * wide.viewport.zoom + 24 + 64 - 1e-6);
  });

  it('never zooms in past 100 %, and centres a graph narrower than the pane', () => {
    const small = fitTrace(bounds(0, 0, 400, 200), 1100);
    expect(small.viewport.zoom).toBe(1);
    expect(small.viewport.x).toBeCloseTo((1100 - 400) / 2, 5);
  });

  it('goes below 40 % (the compact nodes) before it cuts the last node, down to a floor shown from the left', () => {
    const w = fitTrace(bounds(0, 0, 3000, 300), 1000);
    expect(w.viewport.zoom).toBeLessThan(0.4);
    expect(w.viewport.zoom).toBeGreaterThan(0.2);
    const huge = fitTrace(bounds(0, 0, 20000, 300), 1000);
    expect(huge.viewport.zoom).toBe(0.2);
    expect(huge.viewport.x).toBe(24);
  });

  it('allows for the content starting away from the origin, and keeps a minimum height', () => {
    const f = fitTrace(bounds(100, -50, 800, 40), 1000);
    expect(100 * f.viewport.zoom + f.viewport.x).toBeCloseTo((1000 - 800 * f.viewport.zoom) / 2, 5);
    expect(f.height).toBeGreaterThanOrEqual(240);
  });
});
