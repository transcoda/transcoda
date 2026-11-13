import { describe, expect, it } from 'vitest';
import { type EngineEvent, EngineEvents } from './events.ts';

describe('EngineEvents.listen', () => {
  it('calls the listener synchronously for every event, never drops one, and stops after unlisten', () => {
    const events = new EngineEvents();
    const seen: EngineEvent[] = [];
    const unlisten = events.listen((e) => seen.push(e));
    for (let i = 0; i < 250; i += 1) events.publish({ type: 'run.changed', runId: `r${i}` });
    expect(seen).toHaveLength(250);
    expect(seen.some((e) => e.type === 'resync')).toBe(false);
    unlisten();
    events.publish({ type: 'run.changed', runId: 'late' });
    expect(seen).toHaveLength(250);
  });

  it('keeps publishing to others when a listener throws', () => {
    const events = new EngineEvents();
    const seen: string[] = [];
    events.listen(() => {
      throw new Error('boom');
    });
    events.listen((e) => seen.push(e.type));
    events.publish({ type: 'run.changed', runId: 'r' });
    expect(seen).toEqual(['run.changed']);
  });
});
