import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ gpuLoad: vi.fn() }));
vi.mock('../api/client.ts', () => ({ api: { system: { gpuLoad: mocks.gpuLoad } } }));

import { EncoderCard } from './jobs-history.tsx';

afterEach(() => {
  cleanup();
  mocks.gpuLoad.mockReset();
});

const samples = (value: number) => [
  { at: new Date().toISOString(), encoder: value, decoder: value },
];

describe('EncoderCard', () => {
  it('draws one line per GPU, named after it, even when two share a name', async () => {
    mocks.gpuLoad.mockResolvedValue({
      intervalMs: 5000,
      gpus: [
        { id: 'nvidia:0', index: 0, name: 'NVIDIA GeForce RTX 3060', samples: samples(80) },
        { id: 'intel:0000:07:00.0', index: 0, name: 'Intel Arc A310', samples: samples(40) },
        { id: 'intel:0000:08:00.0', index: 1, name: 'Intel Arc A310', samples: samples(10) },
      ],
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(<EncoderCard />);
    await waitFor(() => expect(screen.getByText('NVIDIA GeForce RTX 3060')).toBeTruthy());
    expect(screen.getAllByText('Intel Arc A310')).toHaveLength(2);
    expect(container.querySelectorAll('path.load-line')).toHaveLength(3);
    // series are keyed by GPU id, so same-named cards do not collide
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('a single NVIDIA GPU keeps its encoder and decoder lines', async () => {
    mocks.gpuLoad.mockResolvedValue({
      intervalMs: 5000,
      gpus: [{ id: 'nvidia:0', index: 0, name: 'RTX', samples: samples(80) }],
    });
    render(<EncoderCard />);
    await waitFor(() => expect(screen.getByText('encoder')).toBeTruthy());
    expect(screen.getByText('decoder')).toBeTruthy();
  });

  it('a single Intel GPU shows its name once, with one line called video', async () => {
    mocks.gpuLoad.mockResolvedValue({
      intervalMs: 5000,
      gpus: [{ id: 'intel:0000:07:00.0', index: 0, name: 'Intel Arc A310', samples: samples(40) }],
    });
    render(<EncoderCard />);
    await waitFor(() => expect(screen.getByText('video')).toBeTruthy());
    expect(screen.getAllByText('Intel Arc A310')).toHaveLength(1);
  });

  it('is always shown: "idle" over a flat line without a GPU or while nothing encodes', async () => {
    mocks.gpuLoad.mockResolvedValue({ intervalMs: 5000, gpus: [] });
    const { container } = render(<EncoderCard />);
    await waitFor(() => expect(screen.getByText('idle')).toBeTruthy());
    expect(screen.getByRole('group', { name: 'Encoder · last hour' })).toBeTruthy();
    expect(container.querySelector('.load-baseline')).not.toBeNull();
    cleanup();
    mocks.gpuLoad.mockResolvedValue({
      intervalMs: 5000,
      gpus: [{ id: 'nvidia:0', index: 0, name: 'RTX', samples: samples(0) }],
    });
    render(<EncoderCard />);
    await waitFor(() => expect(screen.getByText('idle')).toBeTruthy());
  });

  it('says the current load while encoding', async () => {
    mocks.gpuLoad.mockResolvedValue({
      intervalMs: 5000,
      gpus: [{ id: 'nvidia:0', index: 0, name: 'RTX', samples: samples(90) }],
    });
    render(<EncoderCard />);
    await waitFor(() => expect(screen.getByText('now 90%')).toBeTruthy());
  });
});
