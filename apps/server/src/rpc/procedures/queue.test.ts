import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { abortableGet, asSession, bearer, createToken, send } from '../../app/testing/http.ts';
import {
  fedLibrary,
  get,
  json,
  queued,
  readEvents,
  root,
  s,
  t,
  UNTIL_MS,
  useRpcApp,
} from './testing.ts';

useRpcApp();

describe('queue and events', () => {
  it('queue.pause persists and queue.status reports it; events stream yields queue.changed first, then job.changed with libraryId/workflowId, and a ping with heartbeatMs 10', async () => {
    const { wf, id: libraryId } = await fedLibrary();
    const read = await createToken(t, s, { name: 'ro', scopes: ['read'] });
    expect((await send(t, 'POST', '/queue/pause', { headers: bearer(read.token) })).status).toBe(
      403,
    );
    const paused = await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) });
    expect(paused.status).toBe(200);
    expect(await json(paused)).toEqual({
      paused: true,
      lanes: { encode: null, quick: null },
      encodeSlots: [{ id: 'encode', label: 'Encode', jobId: null }],
      preparing: [],
    });
    expect(await json(await get('/queue', bearer(read.token)))).toMatchObject({ paused: true });
    expect(t.db.prepare("SELECT value FROM settings WHERE key = 'queue.paused'").get()).toEqual({
      value: 'true',
    });
    const { jobIds } = await queued({ path: join(root, 'a.mkv') });
    const id = jobIds[0] as string;

    const client = abortableGet(t, '/events', {
      accept: 'text/event-stream',
      ...bearer(read.token),
    });
    const res = await client.response;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reading = readEvents(
      res,
      (ev) => ev.some((e) => e.type === 'job.changed') && ev.some((e) => e.type === 'ping'),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(
      (await send(t, 'POST', `/jobs/${id}/pause`, { headers: asSession(s, true) })).status,
    ).toBe(200);
    const events = await reading;
    client.abort();
    expect(events[0]).toEqual({
      type: 'queue.changed',
      paused: true,
      lanes: { encode: null, quick: null },
      encodeSlots: [{ id: 'encode', label: 'Encode', jobId: null }],
    });
    expect(events.find((e) => e.type === 'job.changed')).toMatchObject({
      jobId: id,
      libraryId,
      workflowId: wf,
      state: 'queued',
      paused: true,
      currentNode: null,
    });
    expect(events.find((e) => e.type === 'ping')).toMatchObject({ at: expect.any(String) });

    const resumed = await send(t, 'POST', '/queue/resume', { headers: asSession(s, true) });
    expect(await json(resumed)).toMatchObject({ paused: false });
  });

  it('closing the stream releases the engine subscription', async () => {
    const subscribe = vi.spyOn(t.deps.engine.events, 'subscribe');
    const client = abortableGet(t, '/events', {
      accept: 'text/event-stream',
      ...asSession(s, false),
    });
    const res = await client.response;
    await readEvents(res, (ev) => ev.length >= 2);
    expect(subscribe).toHaveBeenCalledTimes(1);
    const iterator = subscribe.mock.results[0]?.value as AsyncIterableIterator<unknown>;
    client.abort();
    // A live subscription keeps yielding its 10 ms ping; a released one is done. The abort reaches
    // the generator's `finally` through several hops (stream cancel → oRPC return()), so poll.
    await vi.waitFor(
      async () => expect(await iterator.next()).toEqual({ done: true, value: undefined }),
      { timeout: UNTIL_MS, interval: 5 },
    );
  });

  it('events need read; an anonymous stream is 401', async () => {
    const res = await t.app.request('/api/v1/events', {
      headers: { host: 'localhost:8080', accept: 'text/event-stream' },
    });
    expect(res.status).toBe(401);
  });
});
