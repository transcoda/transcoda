import { describe, expect, it } from 'vitest';
import { PluginRestartGate } from './restart-gate.ts';

describe('PluginRestartGate', () => {
  it('does not wait when no plugin is coming back (stopped, disabled, removed or none)', async () => {
    const gate = new PluginRestartGate();
    expect(await gate.waitForRestarts()).toBe(false);
    gate.attachTarget({ comingBackIn: () => null });
    expect(await gate.waitForRestarts()).toBe(false);
  });

  it('waits until the plugin is back', async () => {
    const gate = new PluginRestartGate();
    let polls = 0;
    gate.attachTarget({ comingBackIn: () => (++polls < 4 ? 5_000 : null) });
    expect(await gate.waitForRestarts()).toBe(true);
    expect(polls).toBe(4);
  });

  it('gives up at the deadline of the first answer', async () => {
    let t = 0;
    const gate = new PluginRestartGate(() => t);
    gate.attachTarget({
      comingBackIn: () => {
        t += 60;
        return 100;
      },
    });
    expect(await gate.waitForRestarts()).toBe(true);
  });

  it('stops waiting on an abort', async () => {
    const gate = new PluginRestartGate();
    gate.attachTarget({ comingBackIn: () => 60_000 });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    expect(await gate.waitForRestarts(ctl.signal)).toBe(true);
  });
});
