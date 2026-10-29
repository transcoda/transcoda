import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

const gpu = (
  id: string,
  label: string,
  vendor: 'nvidia' | 'intel' = 'nvidia',
  missing = false,
) => ({
  id,
  label,
  vendor,
  missing,
});
function twoGpus() {
  const s = settingsFixture();
  s.queue.gpus = [
    gpu('nvidia:0', 'GPU 0 · NVIDIA GeForce RTX 3060'),
    gpu('intel:0000:07:00.0', 'Intel Arc A310 · 07:00.0', 'intel'),
  ];
  return s;
}
const orderRows = () =>
  within(screen.getByRole('group', { name: 'GPU order' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent);

describe('QueueSection', () => {
  it('lists the GPUs in order and Save sends the new order after a move', async () => {
    mocks.get.mockResolvedValue(twoGpus());
    mocks.update.mockResolvedValue(twoGpus());
    renderAt('/settings/queue', <QueueSection />);
    await screen.findByRole('group', { name: 'GPU order' });
    expect(screen.getByText('Jobs go to the first free GPU in this order.')).toBeTruthy();
    expect(orderRows()[0]).toContain('GPU 0 · NVIDIA GeForce RTX 3060');
    const first = 'GPU 0 · NVIDIA GeForce RTX 3060';
    const second = 'Intel Arc A310 · 07:00.0';
    // Both buttons on every row; the ones that cannot move are disabled.
    expect(screen.getAllByRole('button', { name: /^Move .* (up|down)$/ })).toHaveLength(4);
    expect(
      (screen.getByRole('button', { name: `Move ${first} up` }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: `Move ${second} down` }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: `Move ${first} down` }));
    // Focus follows the moved row (now last, so its down button is disabled: up).
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Move ${first} up` }));
    expect(orderRows()[0]).toContain('Intel Arc A310');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({ gpuOrder: ['intel:0000:07:00.0', 'nvidia:0'] }),
      ),
    );
  });

  it('marks a GPU that is gone', async () => {
    const s = twoGpus();
    s.queue.gpus.push(gpu('intel:0000:09:00.0', 'intel:0000:09:00.0 (not found)', 'intel', true));
    mocks.get.mockResolvedValue(s);
    renderAt('/settings/queue', <QueueSection />);
    await screen.findByRole('group', { name: 'GPU order' });
    expect(orderRows()[2]).toContain('(not found)');
  });

  it('hides the order with one GPU or a device other than auto', async () => {
    const one = settingsFixture();
    one.queue.gpus = [gpu('nvidia:0', 'GPU 0')];
    mocks.get.mockResolvedValue(one);
    const view = renderAt('/settings/queue', <QueueSection />);
    await screen.findByRole('group', { name: 'Encoding device' });
    expect(screen.queryByRole('group', { name: 'GPU order' })).toBeNull();
    view.unmount();
    const cpu = twoGpus();
    cpu.queue.encodeDevice = { value: 'cpu', default: 'auto', source: { kind: 'database' } };
    mocks.get.mockResolvedValue(cpu);
    renderAt('/settings/queue', <QueueSection />);
    await screen.findByRole('group', { name: 'Encoding device' });
    expect(screen.queryByRole('group', { name: 'GPU order' })).toBeNull();
  });

  it('names the workflows pinned to one vendor, three at most', async () => {
    const s = twoGpus();
    s.queue.pinnedVendorWorkflows = [
      { id: 'w1', name: 'Archive', encoder: 'hevc_nvenc' },
      { id: 'w2', name: 'Two', encoder: 'h264_qsv' },
      { id: 'w3', name: 'Three', encoder: 'hevc_nvenc' },
      { id: 'w4', name: 'Four', encoder: 'hevc_nvenc' },
      { id: 'w5', name: 'Five', encoder: 'hevc_nvenc' },
    ];
    mocks.get.mockResolvedValue(s);
    renderAt('/settings/queue', <QueueSection />);
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain(
      'Archive uses hevc_nvenc, so its jobs only run on that kind of GPU. Set its Encode video encoder to Auto to use every GPU.',
    );
    expect(note.textContent).toContain('Three uses');
    expect(note.textContent).not.toContain('Four uses');
    expect(note.textContent).toContain('and 2 more');
  });

  it('shows no hint without pinned workflows', async () => {
    mocks.get.mockResolvedValue(twoGpus());
    renderAt('/settings/queue', <QueueSection />);
    await screen.findByRole('group', { name: 'GPU order' });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('groups the queue, encoding, then what the server sets (read-only, closed, last)', async () => {
    const { container } = renderAt('/settings/queue', <QueueSection />);
    await screen.findByRole('group', { name: 'Encoding device' });
    // Sentence-case group labels (the shared H3), not mono capitals.
    expect([...container.querySelectorAll('h3.group-h3')].map((h) => h.textContent)).toEqual([
      'Queue',
      'Encoding',
    ]);
    expect(screen.getByRole('region', { name: 'Queue' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Encoding' })).toBeTruthy();
    // The pause switch is outside the form whose Save it would otherwise seem to need.
    const sw = screen.getByRole('switch', { name: 'Queue paused' });
    expect(sw.closest('form')).toBeNull();
    const toggle = screen.getByRole('button', { name: /Set on the server/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Lanes')).toBeNull();
    // Last: after the Save.
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.getByText('Lanes')).toBeTruthy();
    expect(container.querySelector('.settings-server .disclosure-body input')).toBeNull();
  });

  it('the device choices stack on a phone', async () => {
    renderAt('/settings/queue', <QueueSection />);
    const group = await screen.findByRole('group', { name: 'Encoding device' });
    expect(group.querySelector('.setting-radios')?.className).toContain('setting-radios-stack');
    const css = readFileSync(join(__dirname, '../../styles.css'), 'utf8');
    expect(css).toMatch(
      /@media \(max-width: 639px\) \{[^@]*\.setting-radios-stack \{\s*flex-direction: column;/,
    );
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

  it('lanes; stall hours and free space are env values without an input', async () => {
    const { container } = renderAt('/settings/queue', <QueueSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Set on the server/ }));
    expect(screen.getByText('Encode and Quick, one job each')).toBeTruthy();
    // Lanes are always built in: nothing to say about where they come from.
    expect(screen.queryByText('Built in')).toBeNull();
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
    // The encoding device and the retention hold their defaults: no tags.
    expect(screen.queryByText('Default')).toBeNull();
    expect(document.querySelectorAll('.setting-tag')).toHaveLength(0);
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
    // The retention now differs from its default, so its row says where it comes from (the pause
    // switch has no tag: it applies at once).
    await waitFor(() => expect(screen.getAllByText('Set here')).toHaveLength(1));
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
