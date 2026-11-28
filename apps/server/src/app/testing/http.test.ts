import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { abortableGet } from './http.ts';

/** A full garbage collection, without starting Node with --expose-gc. */
function collectGarbage(): void {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
}

describe('abortableGet', () => {
  it('the abort reaches the route even after the request was garbage collected elsewhere', async () => {
    const app = new Hono();
    let aborted = false;
    app.get('/api/v1/slow', (c) => {
      c.req.raw.signal.addEventListener('abort', () => {
        aborted = true;
      });
      return c.text('ok');
    });
    const client = abortableGet({ app }, '/slow');
    expect((await client.response).status).toBe(200);
    // Nothing but the test holds the request now: a collection here once cut the abort off.
    for (let i = 0; i < 3; i++) {
      collectGarbage();
      await new Promise((r) => setTimeout(r, 1));
    }
    client.abort();
    expect(aborted).toBe(true);
  });
});
