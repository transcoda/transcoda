import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), revoke: vi.fn() }));
vi.mock('../../api/client.ts', () => ({
  api: { tokens: mocks },
  isDefinedError: () => false,
  safe: async (p: Promise<unknown>) => {
    try {
      return [null, await p];
    } catch (e) {
      return [e, undefined];
    }
  },
}));

import { TokensSection } from './TokensSection.tsx';

const row = {
  id: 't1',
  name: 'ci-bot',
  scopes: ['read', 'plan'],
  createdAt: '2026-10-01T10:00:00.000Z',
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
};

beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue([row]);
  mocks.create.mockReset();
  mocks.revoke.mockReset().mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe('TokensSection', () => {
  it('renders rows from list', async () => {
    render(<TokensSection />);
    const name = await screen.findByText('ci-bot');
    const tr = name.closest('tr') as HTMLElement;
    expect(within(tr).getByText('read')).toBeTruthy();
    expect(within(tr).getByText('plan')).toBeTruthy();
  });

  it('names the columns in sentence case and capitalises "Never" like every value (L6, L16)', async () => {
    render(<TokensSection />);
    const tr = (await screen.findByText('ci-bot')).closest('tr') as HTMLElement;
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Name',
      'Scopes',
      'Created',
      'Expires',
      'Last used',
      'Actions',
    ]);
    // Never expires, never used.
    expect(within(tr).getAllByText('Never')).toHaveLength(2);
    expect(within(tr).queryByText('never')).toBeNull();
  });

  it('shows the shared loading state while the list loads (L12)', () => {
    mocks.list.mockReturnValue(new Promise(() => {}));
    render(<TokensSection />);
    expect(screen.getByText('Loading…').classList.contains('loading')).toBe(true);
  });

  it('shows the plaintext token once after create and reloads the list', async () => {
    mocks.create.mockResolvedValue({ ...row, id: 't2', name: 'new', token: 'tcd_secretvalue' });
    render(<TokensSection />);
    await screen.findByText('ci-bot');
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'new' } });
    fireEvent.click(screen.getByLabelText('read'));
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByText('tcd_secretvalue')).toBeTruthy();
    expect(screen.getAllByText('tcd_secretvalue')).toHaveLength(1);
    expect(screen.getByText(/won't be shown again/i)).toBeTruthy();
    expect(mocks.create).toHaveBeenCalledWith({ name: 'new', scopes: ['read'] });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: "I've saved it" }));
    expect(screen.queryByText('tcd_secretvalue')).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('resets the copied state when the reveal is dismissed', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mocks.create
      .mockResolvedValueOnce({ ...row, id: 't2', name: 'one', token: 'tcd_one' })
      .mockResolvedValueOnce({ ...row, id: 't3', name: 'two', token: 'tcd_two' });
    render(<TokensSection />);
    await screen.findByText('ci-bot');
    const create = async (name: string) => {
      fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: name } });
      fireEvent.click(screen.getByLabelText('read'));
      fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    };
    await create('one');
    await screen.findByText('tcd_one');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "I've saved it" }));
    expect(screen.getByRole('status').textContent).toBe('');
    await create('two');
    await screen.findByText('tcd_two');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  describe('Copy on plain http (no navigator.clipboard)', () => {
    function setExecCommand(value: unknown) {
      Object.defineProperty(document, 'execCommand', { value, configurable: true, writable: true });
    }
    beforeEach(() => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    });
    afterEach(() => setExecCommand(undefined));

    async function revealToken() {
      mocks.create.mockResolvedValue({ ...row, id: 't2', name: 'new', token: 'tcd_secretvalue' });
      render(<TokensSection />);
      await screen.findByText('ci-bot');
      fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'new' } });
      fireEvent.click(screen.getByLabelText('read'));
      fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
      await screen.findByText('tcd_secretvalue');
    }

    it('copies through execCommand', async () => {
      const exec = vi.fn().mockReturnValue(true);
      setExecCommand(exec);
      await revealToken();
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
      expect(exec).toHaveBeenCalledWith('copy');
    });

    it('selects the token and says which keys to press when copying is impossible', async () => {
      setExecCommand(vi.fn().mockReturnValue(false));
      await revealToken();
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      expect(await screen.findByText(/^Selected\. Press (⌘C|Ctrl\+C) to copy\.$/)).toBeTruthy();
      expect(window.getSelection()?.toString()).toBe('tcd_secretvalue');
      expect(screen.queryByText(/copy failed/i)).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    });
  });

  it('revokes an active token from its "…" menu, then reloads', async () => {
    render(<TokensSection />);
    await screen.findByText('ci-bot');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for ci-bot' }));
    const item = screen.getByRole('menuitem', { name: 'Revoke' });
    expect(item.className).toContain('row-menu-danger');
    fireEvent.click(item);
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith({ id: 't1' }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  });

  it('does not offer revoke for revoked tokens', async () => {
    mocks.list.mockResolvedValue([{ ...row, revokedAt: '2026-10-02T10:00:00.000Z' }]);
    render(<TokensSection />);
    await screen.findByText('ci-bot');
    expect(screen.queryByRole('button', { name: /^Actions for / })).toBeNull();
  });

  it('sends expiry as local end of day, in a non-UTC zone', async () => {
    expect(new Date('2026-10-20T12:00:00').getTimezoneOffset()).not.toBe(0);
    mocks.create.mockResolvedValue({ ...row, token: 'tcd_x' });
    render(<TokensSection />);
    await screen.findByText('ci-bot');
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'n' } });
    fireEvent.click(screen.getByLabelText('read'));
    fireEvent.change(screen.getByLabelText(/Expires/), { target: { value: '2026-10-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    const expected = new Date('2026-10-20T23:59:59.999').toISOString();
    expect(mocks.create).toHaveBeenCalledWith({ name: 'n', scopes: ['read'], expiresAt: expected });
    expect(expected).not.toBe(new Date('2026-10-20T23:59:59.999Z').toISOString());
  });

  it('sends scopes in TOKEN_SCOPES order regardless of click order', async () => {
    mocks.create.mockResolvedValue({ ...row, token: 'tcd_x' });
    render(<TokensSection />);
    await screen.findByText('ci-bot');
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'n' } });
    fireEvent.click(screen.getByLabelText('jobs:create'));
    fireEvent.click(screen.getByLabelText('read'));
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create).toHaveBeenCalledWith({ name: 'n', scopes: ['read', 'jobs:create'] });
  });

  it('keeps Create token disabled until there is a name and a scope, and says what is missing', async () => {
    render(<TokensSection />);
    await screen.findByText('ci-bot');
    const create = screen.getByRole('button', { name: 'Create token' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    const reason = screen.getByText('Enter a name and pick at least one scope');
    expect(create.getAttribute('aria-describedby')).toBe(reason.id);

    // A whitespace-only name does not count.
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: '   ' } });
    fireEvent.click(screen.getByLabelText('read'));
    expect(create.disabled).toBe(true);
    expect(screen.getByText('Enter a name')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'ci' } });
    fireEvent.click(screen.getByLabelText('read'));
    expect(create.disabled).toBe(true);
    expect(screen.getByText('Pick at least one scope')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('plan'));
    expect(create.disabled).toBe(false);
    expect(screen.queryByText(/^(Enter|Pick) /)).toBeNull();
    await act(async () => {});
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('marks the name as required with the shared neutral mark, and has no pointless Cancel', async () => {
    render(<TokensSection />);
    await screen.findByText('ci-bot');
    const name = screen.getByLabelText(/^Name/);
    expect(name.getAttribute('aria-required')).toBe('true');
    expect(document.querySelector(`label[for="${name.id}"] .required-mark`)).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});

describe('TokensSection inside Settings', () => {
  it('has no page heading of its own; its parts are h3 under the section h2', async () => {
    mocks.create.mockResolvedValue({ ...row, id: 't2', name: 'new', token: 'tcd_x' });
    render(<TokensSection />);
    await screen.findByText('ci-bot');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.getByRole('heading', { level: 3, name: 'New token' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'new' } });
    fireEvent.click(screen.getByLabelText('read'));
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByRole('heading', { level: 3, name: '“new” created' })).toBeTruthy();
  });
});
