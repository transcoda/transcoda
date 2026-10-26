import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.ts';

afterEach(() => vi.restoreAllMocks());

describe('logger', () => {
  it('development shows the structured fields after the message', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createLogger('development').info({
      msg: 'plugin finish step',
      plugin: 'example',
      jobId: 'j1',
      nodeId: 'pn',
      reason: 'ok',
      nested: { a: 1 },
    });
    expect(out).toHaveBeenCalledWith(
      'plugin finish step plugin=example jobId=j1 nodeId=pn reason=ok nested={"a":1}',
    );
  });

  it('a plain string and a message without fields print as before', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const log = createLogger('development');
    log.info('hello');
    log.info({ msg: 'bare' });
    expect(out.mock.calls).toEqual([['hello'], ['bare']]);
  });

  it('production stays JSON lines', () => {
    const out = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createLogger('production').warn({ msg: 'm', plugin: 'p' });
    const line = JSON.parse(out.mock.calls[0]?.[0] as string);
    expect(line).toMatchObject({ level: 'warn', msg: 'm', plugin: 'p' });
    expect(typeof line.time).toBe('string');
  });
});
