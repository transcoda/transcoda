import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { installProcessGuards } from './process-guards.ts';

function setup() {
  const target = new EventEmitter();
  const errors: unknown[] = [];
  const fatal: number[] = [];
  installProcessGuards(target, {
    log: { info: () => {}, warn: () => {}, error: (e) => errors.push(e) },
    fatal: (code) => fatal.push(code),
  });
  return { target, errors, fatal };
}

describe('installProcessGuards', () => {
  it('an unhandled rejection is logged and the server keeps running', () => {
    const { target, errors, fatal } = setup();
    target.emit('unhandledRejection', new Error('stray'), Promise.resolve());
    expect(fatal).toEqual([]);
    expect(errors).toEqual([
      expect.objectContaining({ msg: 'unhandled promise rejection', error: 'stray' }),
    ]);
  });

  it('an uncaught exception is logged, then the process exits through the clean fatal path', () => {
    const { target, errors, fatal } = setup();
    target.emit('uncaughtException', new Error('broken state'), 'uncaughtException');
    expect(errors).toEqual([
      expect.objectContaining({ msg: 'uncaught exception, exiting', error: 'broken state' }),
    ]);
    expect(fatal).toEqual([1]);
  });

  it('a second uncaught exception during the fatal path does not run it again', () => {
    const { target, fatal } = setup();
    target.emit('uncaughtException', new Error('one'), 'uncaughtException');
    target.emit('uncaughtException', new Error('two'), 'uncaughtException');
    expect(fatal).toEqual([1]);
  });
});
