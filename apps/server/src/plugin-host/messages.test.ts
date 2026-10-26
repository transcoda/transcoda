import { type HostMessage, MAX_MESSAGE_BYTES, messageBytes } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { capMessage, FETCH_TOO_LARGE, fetchTooLarge } from './messages.ts';

const big = 'x'.repeat(MAX_MESSAGE_BYTES + 1);

describe('message caps', () => {
  it('truncates an oversize log line', () => {
    const log: HostMessage = {
      v: 1,
      id: 'log',
      type: 'log',
      level: 'info',
      message: big,
      jobId: null,
    };
    const capped = capMessage(log);
    expect(capped.type).toBe('log');
    expect(messageBytes(capped)).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(capped.type === 'log' && capped.message.endsWith('[truncated]')).toBe(true);
  });

  it('truncates an oversize fatal reason', () => {
    const fatal: HostMessage = { v: 1, id: 'host', type: 'fatal', reason: big };
    const capped = capMessage(fatal);
    expect(messageBytes(capped)).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(capped.type === 'fatal' && capped.reason.endsWith('[truncated]')).toBe(true);
  });

  it('answers an oversize result with an error under the same id', () => {
    const result: HostMessage = { v: 1, id: 'r1', type: 'result', ok: true, result: big };
    expect(capMessage(result)).toMatchObject({ id: 'r1', ok: false });
  });

  it('settles an oversize fetch locally as failed', () => {
    const fetch: HostMessage = {
      v: 1,
      id: 'f1',
      type: 'fetch',
      callId: null,
      input: { url: 'https://a.test/', method: 'POST', headers: {}, body: big, accept: 'json' },
    };
    expect(fetchTooLarge(fetch)).toBe(true);
    expect(FETCH_TOO_LARGE).toEqual({
      ok: false,
      error: { kind: 'failed', message: 'request larger than 16 MB' },
    });
  });
});
