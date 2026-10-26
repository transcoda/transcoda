import {
  type FetchResult,
  type HostMessage,
  type JsonValue,
  MAX_MESSAGE_BYTES,
  messageBytes,
  PROTOCOL_VERSION,
} from '@transcoda/shared';

/** Builds the `result` for a call that threw or produced something unsendable. */
export function errorResult(id: string, message: string): HostMessage {
  return {
    v: PROTOCOL_VERSION,
    id,
    type: 'result',
    ok: false,
    error: { message, retryable: false },
  };
}

export function okResult(id: string, result: JsonValue): HostMessage {
  return { v: PROTOCOL_VERSION, id, type: 'result', ok: true, result };
}

const LOG_TRUNCATE_CHARS = 1_000_000;
const LOG_TRUNCATED = '... [truncated]';

/** True when a `fetch` request is over the cap: it is answered locally, never sent. */
export function fetchTooLarge(message: HostMessage): boolean {
  return message.type === 'fetch' && messageBytes(message) > MAX_MESSAGE_BYTES;
}

export const FETCH_TOO_LARGE: FetchResult = {
  ok: false,
  error: { kind: 'failed', message: 'request larger than 16 MB' },
};

/**
 * A message over the cap is never sent as is: a result becomes an error answer with the same id,
 * a log line is truncated.
 */
export function capMessage(message: HostMessage): HostMessage {
  if (messageBytes(message) <= MAX_MESSAGE_BYTES) return message;
  if (message.type === 'result') return errorResult(message.id, 'result larger than 16 MB');
  if (message.type === 'fatal') {
    return { ...message, reason: message.reason.slice(0, LOG_TRUNCATE_CHARS) + LOG_TRUNCATED };
  }
  if (message.type === 'log') {
    return { ...message, message: message.message.slice(0, LOG_TRUNCATE_CHARS) + LOG_TRUNCATED };
  }
  return message;
}

/** Waiters for the server's `fetch-result` answers, keyed by the host's own request id. */
export function createFetchWaiters(): {
  wait(id: string): Promise<FetchResult>;
  settle(id: string, result: FetchResult): boolean;
} {
  const pending = new Map<string, (r: FetchResult) => void>();
  return {
    wait: (id) => new Promise((resolve) => pending.set(id, resolve)),
    settle(id, result) {
      const resolve = pending.get(id);
      if (!resolve) return false;
      pending.delete(id);
      resolve(result);
      return true;
    },
  };
}
