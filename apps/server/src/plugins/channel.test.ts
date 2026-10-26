import { describe, expect, it } from 'vitest';
import { createFrameReader } from './channel.ts';

function reader(maxChars = 1_000) {
  const messages: unknown[] = [];
  const bad: string[] = [];
  const feed = createFrameReader({
    maxChars,
    onMessage: (m) => messages.push(m),
    onBadFrame: (why) => bad.push(why),
  });
  return { feed, messages, bad };
}

describe('createFrameReader', () => {
  it('parses newline-delimited JSON across chunk boundaries', () => {
    const { feed, messages, bad } = reader();
    feed('{"a":1}\n{"b"');
    feed(':2}\n');
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
    expect(bad).toEqual([]);
  });

  it('reports a frame that is not JSON once, and ignores everything after it', () => {
    const { feed, messages, bad } = reader();
    feed('{"a":1}\n\u0000\u0000\u0000\tÿ\u000fgarbage\n{"b":2}\n');
    expect(messages).toEqual([{ a: 1 }]);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain('malformed message frame');
    feed('{"c":3}\n');
    expect(messages).toEqual([{ a: 1 }]);
    expect(bad).toHaveLength(1);
  });

  it('reports an oversized frame without waiting for its newline', () => {
    const { feed, messages, bad } = reader(10);
    feed('{"a":"0123456789');
    expect(messages).toEqual([]);
    expect(bad[0]).toContain('over 10 characters');
  });
});
