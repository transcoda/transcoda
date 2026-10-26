import type { EngineEvent } from '@transcoda/contract';
import { os, requireScope } from '../middleware.ts';

/**
 * The engine's events for one subscriber: first a `queue.changed` snapshot, then everything
 * published (with the heartbeat `ping`) until the client goes away. The subscription starts before
 * the snapshot is read, so no change between the two is lost.
 */
export const subscribe = os.events.subscribe.use(requireScope('read')).handler(async function* ({
  context,
  signal,
}): AsyncGenerator<EngineEvent> {
  const { engine } = context.deps;
  const events = engine.events.subscribe(signal);
  try {
    const { paused, lanes, encodeSlots } = engine.scheduler.status();
    yield { type: 'queue.changed', paused, lanes, encodeSlots };
    for await (const e of events) yield e;
  } finally {
    await events.return?.();
  }
});
