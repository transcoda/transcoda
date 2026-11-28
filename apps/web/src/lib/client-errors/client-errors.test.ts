import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORPCError } from '@orpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clientErrorInterceptor,
  describeThrown,
  installClientErrors,
  reactRootOptions,
  reportApiFailure,
} from './client-errors.ts';
import { ClientErrorReporter } from './reporter.ts';

function fakeReporter() {
  const r = new ClientErrorReporter({
    send: vi.fn(),
    csrf: () => 'tok',
    route: () => '/',
    version: 'x',
    now: () => 0,
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
  const capture = vi.spyOn(r, 'capture');
  const flush = vi.spyOn(r, 'flush');
  const close = vi.spyOn(r, 'close');
  const reopen = vi.spyOn(r, 'reopen');
  return { r, capture, flush, close, reopen };
}

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

describe('installClientErrors', () => {
  it('reports an uncaught error with its stack', () => {
    const { r, capture } = fakeReporter();
    uninstall = installClientErrors(window, r);
    const error = new TypeError('x is not a function');
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));
    expect(capture).toHaveBeenCalledWith({
      kind: 'error',
      name: 'TypeError',
      message: 'x is not a function',
      stack: error.stack,
    });
  });

  it('gives an error without an Error object its script position as the stack', () => {
    const { r, capture } = fakeReporter();
    uninstall = installClientErrors(window, r);
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'Uncaught oops',
        filename: 'http://h/assets/i.js',
        lineno: 3,
        colno: 4,
      }),
    );
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Uncaught oops',
        stack: '    at http://h/assets/i.js:3:4',
      }),
    );
  });

  it('ignores a resource that failed to load (not an ErrorEvent)', () => {
    const { r, capture } = fakeReporter();
    uninstall = installClientErrors(window, r);
    window.dispatchEvent(new Event('error'));
    expect(capture).not.toHaveBeenCalled();
  });

  it('reports an unhandled rejection', () => {
    const { r, capture } = fakeReporter();
    uninstall = installClientErrors(window, r);
    const ev = new Event('unhandledrejection') as Event & { reason: unknown };
    ev.reason = new RangeError('bad');
    window.dispatchEvent(ev);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'rejection', name: 'RangeError', message: 'bad' }),
    );
  });

  it('reports a CSP violation with the directive and what it blocked', () => {
    const { r, capture } = fakeReporter();
    uninstall = installClientErrors(window, r);
    const ev = Object.assign(new Event('securitypolicyviolation'), {
      effectiveDirective: 'script-src',
      blockedURI: 'inline',
      sourceFile: 'http://h/assets/i.js',
      lineNumber: 1,
      columnNumber: 2,
    });
    document.dispatchEvent(ev);
    expect(capture).toHaveBeenCalledWith({
      kind: 'csp',
      name: 'SecurityPolicyViolation',
      message: 'script-src blocked inline',
      stack: '    at http://h/assets/i.js:1:2',
    });
  });

  it('sends on pagehide, holds errors until pageshow, and sends when the tab is hidden', () => {
    const { r, flush, close, reopen } = fakeReporter();
    uninstall = installClientErrors(window, r);
    window.dispatchEvent(new Event('pagehide'));
    expect(close).toHaveBeenCalled();
    window.dispatchEvent(new Event('pageshow'));
    expect(reopen).toHaveBeenCalled();
    flush.mockClear();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(flush).toHaveBeenCalled();
  });

  it('stops listening when uninstalled', () => {
    const { r, capture } = fakeReporter();
    installClientErrors(window, r)();
    // Without an Error object: Vitest reports an error event with one that nothing handles.
    window.dispatchEvent(new ErrorEvent('error', { message: 'x' }));
    const ev = new Event('unhandledrejection') as Event & { reason: unknown };
    ev.reason = 'x';
    window.dispatchEvent(ev);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('describeThrown', () => {
  it('keeps only the status and code of an API error, never its message', () => {
    const e = new ORPCError('NOT_FOUND', { status: 404, message: 'No workflow "Harbor Lights"' });
    expect(describeThrown('rejection', e)).toEqual({
      kind: 'rejection',
      name: 'ORPCError',
      message: '404 NOT_FOUND',
    });
  });

  it('handles a thrown string and a thrown object', () => {
    expect(describeThrown('error', 'boom').message).toBe('boom');
    expect(describeThrown('error', { a: 1 }).message).toBe(
      'A value that is not an Error was thrown',
    );
  });
});

describe('API failures', () => {
  it('reports an undefined error by procedure, status and code', () => {
    const { r, capture } = fakeReporter();
    reportApiFailure(['jobs', 'list'], new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 }), r);
    reportApiFailure(['jobs', 'get'], new TypeError('Failed to fetch'), r);
    expect(capture.mock.calls.map(([e]) => e.message)).toEqual([
      'jobs.list 500 INTERNAL_SERVER_ERROR',
      'jobs.get 0 NETWORK',
    ]);
    expect(capture.mock.calls[0]?.[0]).toMatchObject({ kind: 'api', name: 'ApiError' });
  });

  it('leaves out the contract errors pages show, and aborts', () => {
    const { r, capture } = fakeReporter();
    const defined = new ORPCError('NOT_FOUND', { defined: true, status: 404 });
    reportApiFailure(['workflows', 'get'], defined, r);
    reportApiFailure(['jobs', 'list'], new DOMException('aborted', 'AbortError'), r);
    expect(capture).not.toHaveBeenCalled();
  });

  it('the interceptor rethrows what it reports', async () => {
    const boom = new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 });
    await expect(
      clientErrorInterceptor({ path: ['x'], next: () => Promise.reject(boom) }),
    ).rejects.toBe(boom);
    await expect(clientErrorInterceptor({ path: ['x'], next: async () => 7 })).resolves.toBe(7);
  });
});

describe('reactRootOptions', () => {
  it('reports a render error once, though it also reaches the window', () => {
    const { r, capture } = fakeReporter();
    uninstall = installClientErrors(window, r);
    const error = new Error('render failed');
    const reportError = vi.fn((e: unknown) => {
      window.dispatchEvent(new ErrorEvent('error', { error: e }));
    });
    vi.stubGlobal('reportError', reportError);
    try {
      reactRootOptions(r).onUncaughtError?.(error, { componentStack: '' });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(reportError).toHaveBeenCalledWith(error);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'render', message: 'render failed' }),
    );
  });
});

describe('the app’s own errors', () => {
  it('build their messages from fixed text, so a report cannot carry a title the scrubber misses', () => {
    const src = join(__dirname, '..', '..');
    const offenders = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.|testing/.test(f))
      .filter((f) => /new \w*Error\(\s*`[^`]*\$\{/.test(readFileSync(join(src, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
