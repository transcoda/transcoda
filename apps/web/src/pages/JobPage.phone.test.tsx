import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jobs: {
    get: vi.fn(),
    log: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    queue: vi.fn(),
  },
  workflows: { get: vi.fn(), list: vi.fn() },
  libraries: { get: vi.fn() },
  nodes: { list: vi.fn() },
  queue: { status: vi.fn() },
  events: { subscribe: vi.fn() },
  recycle: { restore: vi.fn() },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { Route, Switch } from 'wouter';
import { resetCatalogCache } from '../hooks/useCatalog.ts';
import { EventsProvider } from '../hooks/useEvents.ts';
import { PHONE_QUERY } from '../lib/usePhone.ts';
import { fakeEventSource } from '../test/fakeEventStream.ts';
import { nodesFixture } from '../test/fixtures/catalog.ts';
import { jobDetail } from '../test/fixtures/trace.ts';
import { renderAt } from '../test/render.tsx';
import { JobPage } from './JobPage.tsx';

const realMatchMedia = window.matchMedia;

function setPhone(phone: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches: phone && query === PHONE_QUERY,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

beforeEach(() => {
  resetCatalogCache();
  const fake = fakeEventSource();
  mocks.events.subscribe.mockReset().mockImplementation(fake.subscribe);
  mocks.nodes.list.mockReset().mockResolvedValue({ nodes: nodesFixture });
  mocks.workflows.get
    .mockReset()
    .mockResolvedValue({ id: 'w1', name: 'TV cleanup', kind: 'workflow', version: 7 });
  mocks.workflows.list.mockReset().mockResolvedValue({ workflows: [] });
  mocks.jobs.get.mockReset().mockResolvedValue(jobDetail({ state: 'done' }));
  mocks.jobs.log.mockReset().mockResolvedValue({ log: '' });
  mocks.queue.status
    .mockReset()
    .mockResolvedValue({ paused: false, lanes: { encode: null, quick: null }, preparing: [] });
});
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

async function open() {
  renderAt(
    '/jobs/j1',
    <EventsProvider>
      <Switch>
        <Route path="/jobs/:id">
          <JobPage />
        </Route>
      </Switch>
    </EventsProvider>,
  );
  await screen.findByRole('heading', { level: 1 });
  await act(async () => {});
}

describe('JobPage: the workflow drawing on a phone', () => {
  it('is closed under a "Workflow" toggle on a phone, after the steps, and opens on demand', async () => {
    setPhone(true);
    await open();
    const toggle = screen.getByRole('button', { name: 'Workflow' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Workflow trace' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'Workflow trace' })).toBeTruthy();
  });

  it('is drawn open, with no toggle, on a wider window', async () => {
    setPhone(false);
    await open();
    expect(screen.getByRole('region', { name: 'Workflow trace' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Workflow' })).toBeNull();
  });
});
