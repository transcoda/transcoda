import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsFixture } from './settingsFixture.ts';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  status: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
}));
vi.mock('../../api/client.ts', () => ({
  api: {
    settings: { get: mocks.get, update: mocks.update },
    queue: { status: mocks.status, pause: mocks.pause, resume: mocks.resume },
  },
}));

import { renderAt } from '../../test/render.tsx';
import { QueueSection } from './QueueSection.tsx';

const lanes = { encode: null, quick: null };
beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(settingsFixture());
  mocks.update.mockReset();
  mocks.status.mockReset().mockResolvedValue({ paused: false, lanes });
  mocks.pause.mockReset().mockResolvedValue({ paused: true, lanes });
  mocks.resume.mockReset().mockResolvedValue({ paused: false, lanes });
});
afterEach(cleanup);

/** "Test encodes kept for" sits under Advanced, closed by default. */
async function keepField() {
  fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
  return screen.getByRole('spinbutton', { name: 'Test encodes kept for' }) as HTMLInputElement;
}

describe('QueueSection', () => {
  it('groups the queue, encoding, then what the server sets (read-only, last)', async () => {
    renderAt('/settings/queue', <QueueSection />);
    await screen.findByText('Lanes');
    expect(
      [...document.querySelectorAll('.settings-group-head')].map((h) => h.textContent),
    ).toEqual(['Queue', 'Encoding', 'Set on the server']);
    const readOnly = screen.getByRole('region', { name: 'Set on the server' });
    expect(within(readOnly).getByText('Lanes')).toBeTruthy();
    expect(within(readOnly).queryByRole('spinbutton')).toBeNull();
  });

  it('Advanced is closed by default, opens as a real disclosure and says when it holds a change', async () => {
    const s = settingsFixture();
    s.queue.testEncodeKeepHours = { value: 6, default: 2, source: { kind: 'database' } };
    mocks.get.mockResolvedValue(s);
    renderAt('/settings/queue', <QueueSection />);
    const toggle = await screen.findByRole('button', { name: /Advanced/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('1 changed');
    expect(screen.queryByRole('spinbutton', { name: 'Test encodes kept for' })).toBeNull();
    const body = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(body?.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(body?.hidden).toBe(false);
    expect(
      (screen.getByRole('spinbutton', { name: 'Test encodes kept for' }) as HTMLInputElement).value,
    ).toBe('6');
  });

  it('the paused switch pauses the queue at once (no Save) and says what that means', async () => {
    renderAt('/settings/queue', <QueueSection />);
    const sw = await screen.findByRole('switch', { name: 'Queue paused' });
    await waitFor(() => expect((sw as HTMLButtonElement).disabled).toBe(false));
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => expect(mocks.pause).toHaveBeenCalled());
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(
      screen.getByText('Queue paused — running jobs are frozen, nothing new starts'),
    ).toBeTruthy();
    // The only Save belongs to the retention form, which the switch leaves untouched.
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(sw);
    await waitFor(() => expect(mocks.resume).toHaveBeenCalled());
  });

  it('lanes are built in; stall hours and free space are env values without an input', async () => {
    const { container } = renderAt('/settings/queue', <QueueSection />);
    expect(await screen.findByText('Encode and Quick, one job each')).toBeTruthy();
    expect(screen.getByText('Built in')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /stall/i })).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: /stall/i })).toBeNull();
    expect(screen.getByText('6 hours')).toBeTruthy();
    expect(screen.getByText('10.7 GB (10 GiB)')).toBeTruthy();
    const vars = [...container.querySelectorAll('.setting-source code')].map((c) => c.textContent);
    expect(vars).toEqual(['TRANSCODA_HEALTH_STALL_HOURS', 'TRANSCODA_HEALTH_MIN_FREE_GIB']);
    expect(container.textContent).toContain('Default · set TRANSCODA_HEALTH_STALL_HOURS to change');
    expect(container.textContent).toContain('From TRANSCODA_HEALTH_MIN_FREE_GIB');
  });

  it('test encodes kept for: shows 2 hours by default with its hint and source', async () => {
    renderAt('/settings/queue', <QueueSection />);
    const field = await keepField();
    expect(field.value).toBe('2');
    const hint = screen.getByText(
      'Outputs of test-encode dry runs, kept for playing and download. 0 deletes them after measuring.',
    );
    expect(field.getAttribute('aria-describedby')).toContain(hint.id);
    expect(screen.getByText('hours')).toBeTruthy();
    // The encoding device and the retention, both unset.
    expect(screen.getAllByText('Default')).toHaveLength(2);
  });

  it('saves a changed retention and shows the answer as set here', async () => {
    const answer = settingsFixture();
    answer.queue.testEncodeKeepHours = { value: 6, default: 2, source: { kind: 'database' } };
    mocks.update.mockResolvedValue(answer);
    renderAt('/settings/queue', <QueueSection />);
    const field = await keepField();
    fireEvent.change(field, { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ testEncodeKeepHours: 6 }));
    // The pause switch says "Set here" too; the retention row now does as well.
    await waitFor(() => expect(screen.getAllByText('Set here')).toHaveLength(2));
    expect(field.value).toBe('6');
  });

  it('encoding device: auto by default, each detected GPU a choice; a change is saved', async () => {
    const answer = settingsFixture();
    answer.queue.encodeDevice = {
      value: 'nvidia:0',
      default: 'auto',
      source: { kind: 'database' },
    };
    mocks.update.mockResolvedValue(answer);
    renderAt('/settings/queue', <QueueSection />);
    const group = await screen.findByRole('group', { name: 'Encoding device' });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.labels?.[0]?.textContent)).toEqual([
      'Auto',
      'CPU only',
      'GPU 0 · NVIDIA GeForce RTX 3060',
    ]);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
    expect(
      within(group).getByText(
        'Where video is decoded and encoded. Auto uses a GPU when there is one. CPU only never uses a GPU.',
      ),
    ).toBeTruthy();
    fireEvent.click(within(group).getByRole('radio', { name: 'GPU 0 · NVIDIA GeForce RTX 3060' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ encodeDevice: 'nvidia:0' }));
  });

  it('a stored GPU that is gone is shown checked, with a warning', async () => {
    const s = settingsFixture();
    s.queue.encodeDevice = { value: 'nvidia:1', default: 'auto', source: { kind: 'database' } };
    s.queue.encodeDevices.push({
      id: 'nvidia:1',
      label: 'GPU 1 (not found: encodes on the CPU)',
      missing: true,
    });
    mocks.get.mockResolvedValue(s);
    renderAt('/settings/queue', <QueueSection />);
    const gone = (await screen.findByRole('radio', {
      name: 'GPU 1 (not found: encodes on the CPU)',
    })) as HTMLInputElement;
    expect(gone.checked).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe(
      'GPU 1 was not found when the server started. Jobs encode on the CPU until you pick another device.',
    );
  });

  it('a retention above 72 is marked invalid and not sent', async () => {
    renderAt('/settings/queue', <QueueSection />);
    const field = await keepField();
    fireEvent.change(field, { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a whole number from 0 to 72')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
