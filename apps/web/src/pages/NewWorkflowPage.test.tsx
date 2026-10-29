import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '../test/render.tsx';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: { workflows: mocks }, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { NewWorkflowPage } from './NewWorkflowPage.tsx';

const WORKFLOW = 'Workflow — runs on files from a trigger';
const SUBWORKFLOW = 'Sub-workflow — a reusable piece run from a workflow';

beforeEach(() => {
  mocks.create.mockReset();
});
afterEach(cleanup);

describe('NewWorkflowPage', () => {
  it('preselects the kind from ?kind=subworkflow and navigates to the new editor on create', async () => {
    mocks.create.mockResolvedValue({ id: 'abc', name: 'Audio tidy', kind: 'subworkflow' });
    const view = renderAt('/workflows/new?kind=subworkflow', <NewWorkflowPage />);
    expect((screen.getByRole('radio', { name: SUBWORKFLOW }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByRole('radio', { name: WORKFLOW }) as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: '  Audio tidy ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and open' }));
    await waitFor(() => expect(view.location()).toBe('/workflows/abc'));
    expect(mocks.create).toHaveBeenCalledWith({ name: 'Audio tidy', kind: 'subworkflow' });
  });

  it('says "New workflows never touch files until you activate a version." for a workflow only', () => {
    renderAt('/workflows/new', <NewWorkflowPage />);
    expect(
      screen.getByText('New workflows never touch files until you activate a version.'),
    ).toBeTruthy();
    cleanup();
    renderAt('/workflows/new?kind=subworkflow', <NewWorkflowPage />);
    expect(screen.queryByText(/activate/i)).toBeNull();
    expect(
      screen.getByText('A sub-workflow is a reusable piece. It only runs when a workflow runs it.'),
    ).toBeTruthy();
  });

  it('has a Cancel that goes back to the list, before the primary (primary last)', () => {
    renderAt('/workflows/new', <NewWorkflowPage />);
    const cancel = screen.getByRole('link', { name: 'Cancel' });
    expect(cancel.getAttribute('href')).toBe('/workflows');
    const create = screen.getByRole('button', { name: 'Create and open' });
    expect(cancel.parentElement).toBe(create.parentElement);
    expect(cancel.parentElement?.lastElementChild).toBe(create);
  });

  it('defaults to a workflow, marks the name required, and keeps Create disabled until it has one, with no "Enter a name" line', async () => {
    renderAt('/workflows/new', <NewWorkflowPage />);
    expect((screen.getByRole('radio', { name: WORKFLOW }) as HTMLInputElement).checked).toBe(true);
    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    expect(name.maxLength).toBe(120);
    expect(name.getAttribute('aria-required')).toBe('true');
    expect(document.querySelector(`label[for="${name.id}"] .required-mark`)).not.toBeNull();
    const create = screen.getByRole('button', { name: 'Create and open' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(create.hasAttribute('aria-describedby')).toBe(false);
    expect(screen.queryByText('Enter a name')).toBeNull();
    fireEvent.change(name, { target: { value: '   ' } });
    expect(create.disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Smoke' } });
    expect(create.disabled).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('keeps the form and shows an alert when create fails', async () => {
    mocks.create.mockRejectedValue(new Error('network'));
    const view = renderAt('/workflows/new?kind=workflow', <NewWorkflowPage />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Smoke' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and open' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not create the workflow, try again',
    );
    expect(view.location()).toBe('/workflows/new?kind=workflow');
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Smoke');
  });
});
