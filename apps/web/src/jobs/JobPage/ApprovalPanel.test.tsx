import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jobs: { approve: vi.fn(), reject: vi.fn() },
}));
vi.mock('../../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { ORPCError } from '@orpc/client';
import { ToastProvider } from '../../components/Toast.tsx';
import { fmtDate } from '../../lib/time.ts';
import { type ApprovalJob, ApprovalPanel } from './ApprovalPanel.tsx';

const waiting: ApprovalJob = {
  id: 'j1',
  plan: null,
  approval: {
    parkedAt: '2026-10-16T18:20:00.000Z',
    expiresAt: '2026-10-23T18:20:00.000Z',
    beforeBytes: 2_000_000_000,
    afterBytes: 1_200_000_000,
  },
};

function show(job: ApprovalJob, onChanged = vi.fn()) {
  render(
    <ToastProvider>
      <ApprovalPanel job={job} onChanged={onChanged} />
    </ToastProvider>,
  );
  return onChanged;
}

beforeEach(() => {
  mocks.jobs.approve.mockReset().mockResolvedValue({ ok: true });
  mocks.jobs.reject.mockReset().mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe('ApprovalPanel', () => {
  it('says what waits, how much it saves, and until when; nothing for a job not waiting', () => {
    show(waiting);
    expect(screen.getByRole('heading', { name: 'Waiting for your approval' })).toBeTruthy();
    expect(screen.getByText('2.00 GB → 1.20 GB, saved 800 MB')).toBeTruthy();
    expect(
      screen.getByText(
        `Nothing on disk has changed yet. Without an answer by ${fmtDate(waiting.approval?.expiresAt ?? '')}, the result is rejected and the original kept.`,
      ),
    ).toBeTruthy();
    cleanup();
    const { container } = render(
      <ToastProvider>
        <ApprovalPanel job={{ ...waiting, approval: null }} onChanged={vi.fn()} />
      </ToastProvider>,
    );
    expect(container.querySelector('.approval')).toBeNull();
  });

  it('Approve answers at once and refreshes the page', async () => {
    const onChanged = show(waiting);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.jobs.approve).toHaveBeenCalledWith({ id: 'j1' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mocks.jobs.reject).not.toHaveBeenCalled();
  });

  it('Reject asks first; keeping the result waiting sends nothing', async () => {
    const onChanged = show(waiting);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject this result?' });
    expect(dialog.textContent).toContain('The result is discarded and the original kept.');
    fireEvent.click(screen.getByRole('button', { name: 'Keep waiting' }));
    expect(mocks.jobs.reject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject result' }));
    await waitFor(() => expect(mocks.jobs.reject).toHaveBeenCalledWith({ id: 'j1' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('a result no longer waiting says so and refreshes', async () => {
    mocks.jobs.approve.mockRejectedValue(
      new ORPCError('JOB_NOT_ACTIVE', {
        defined: true,
        status: 409,
        message: 'The job is not waiting for approval',
      }),
    );
    const onChanged = show(waiting);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('That result is no longer waiting for approval')).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });
});
