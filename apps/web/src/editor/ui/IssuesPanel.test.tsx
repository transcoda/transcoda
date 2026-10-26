import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Issue } from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { chainMainReplace } from '../../test/fixtures/graphs.ts';
import { IssuesPanel } from './IssuesPanel.tsx';

afterEach(cleanup);

const issues: Issue[] = [
  { severity: 'warning', code: 'NODE_UNREACHABLE', message: 'Never reached', nodeId: 'ro' },
  {
    severity: 'error',
    code: 'INVALID_SETTINGS',
    message: 'Needs a setting',
    nodeId: 'keep',
    settingPath: 'languages',
  },
  { severity: 'error', code: 'NO_FINISH_PATH', message: 'No path reaches a finish node' },
];

describe('IssuesPanel', () => {
  it('IssuesPanel summarises "2 errors · 1 warning" and focuses the node of a clicked entry', () => {
    const onFocus = vi.fn();
    render(
      <IssuesPanel
        issues={issues}
        catalog={catalogFixture}
        graph={chainMainReplace()}
        onFocus={onFocus}
      />,
    );
    const panel = screen.getByRole('group');
    expect(panel.querySelector('summary')?.textContent).toBe('2 errors · 1 warning');
    const buttons = within(panel).getAllByRole('button');
    // Errors first, then warnings; each entry names its node (or "Workflow") and the message.
    expect(buttons.map((b) => b.textContent)).toEqual([
      'ErrorKeep languagesLanguages to keep: Needs a setting',
      'ErrorWorkflowNo path reaches a finish node',
      'WarningReplace originalNever reached',
    ]);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(onFocus).toHaveBeenCalledWith({ nodeId: 'keep', settingPath: 'languages' });
    fireEvent.click(buttons[2] as HTMLElement);
    expect(onFocus).toHaveBeenLastCalledWith({ nodeId: 'ro' });
  });

  it('names edges "Edge" and uses singular and empty summaries', () => {
    const onFocus = vi.fn();
    const { rerender, container } = render(
      <IssuesPanel
        issues={[
          {
            severity: 'error',
            code: 'PORT_TYPE_MISMATCH',
            message: 'Ports do not match',
            edgeId: 'in-keep',
          },
        ]}
        catalog={catalogFixture}
        graph={chainMainReplace()}
        onFocus={onFocus}
      />,
    );
    expect(container.querySelector('summary')?.textContent).toBe('1 error');
    fireEvent.click(screen.getByRole('button', { name: /Edge/ }));
    expect(onFocus).toHaveBeenCalledWith({ edgeId: 'in-keep' });

    rerender(
      <IssuesPanel issues={[]} catalog={null} graph={chainMainReplace()} onFocus={onFocus} />,
    );
    expect(container.querySelector('summary')?.textContent).toBe('No issues');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('drops a leading "<node title>: " from a message shown under that node', () => {
    const named: Issue[] = [
      {
        severity: 'error',
        code: 'INPUT_UNCONNECTED',
        message: 'Keep languages: input "file" is not connected',
        nodeId: 'keep',
      },
      { severity: 'error', code: 'NO_FINISH_PATH', message: 'Keep languages: workflow-level' },
    ];
    render(
      <IssuesPanel
        issues={named}
        catalog={catalogFixture}
        graph={chainMainReplace()}
        onFocus={vi.fn()}
      />,
    );
    const buttons = within(screen.getByRole('group')).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'ErrorKeep languagesinput "file" is not connected',
      // Not under a node: the message stays whole.
      'ErrorWorkflowKeep languages: workflow-level',
    ]);
  });

  it('an issue of a node removed since the last validation reads "Removed node"', () => {
    render(
      <IssuesPanel
        issues={[
          {
            severity: 'error',
            code: 'INPUT_UNCONNECTED',
            message: 'Not connected',
            nodeId: 'gone',
          },
        ]}
        catalog={catalogFixture}
        graph={chainMainReplace()}
        onFocus={() => {}}
      />,
    );
    expect(screen.getByRole('button').textContent).toBe('ErrorRemoved nodeNot connected');
  });

  it('names the setting of a settings issue so two issues of one node read differently', () => {
    const graph = chainMainReplace();
    graph.nodes.push({
      id: 'run',
      type: 'core:run-subworkflow',
      typeVersion: 1,
      settings: {},
      position: { x: 0, y: 200 },
    });
    const twoSettings: Issue[] = [
      {
        severity: 'error',
        code: 'INVALID_SETTINGS',
        message: 'Needs a setting',
        nodeId: 'run',
        settingPath: 'subworkflowId',
      },
      {
        severity: 'error',
        code: 'INVALID_SETTINGS',
        message: 'Needs a setting',
        nodeId: 'run',
        settingPath: 'version',
      },
      {
        severity: 'error',
        code: 'INVALID_SETTINGS',
        message: 'Languages to keep: must not be empty',
        nodeId: 'keep',
        settingPath: 'languages',
      },
    ];
    render(
      <IssuesPanel issues={twoSettings} catalog={catalogFixture} graph={graph} onFocus={vi.fn()} />,
    );
    const buttons = within(screen.getByRole('group')).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'ErrorRun sub-workflowSub-workflow: Needs a setting',
      'ErrorRun sub-workflowPinned version: Needs a setting',
      // Already named: not repeated.
      'ErrorKeep languagesLanguages to keep: must not be empty',
    ]);
  });
});
