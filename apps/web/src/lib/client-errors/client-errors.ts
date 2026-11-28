// The web UI's error reports (docs/dev/web-ui.md, "Error reports"): uncaught errors, unhandled
// rejections, CSP violations, React render failures and unexpected API failures go, scrubbed, to
// the Transcoda server that served the page, and nowhere else.
import { ORPCError } from '@orpc/client';
import { CLIENT_ERRORS_PATH, type ClientErrorKind } from '@transcoda/shared';
import type { RootOptions } from 'react-dom/client';
import { csrfToken } from '../../api/csrf.ts';
import { type CapturedError, ClientErrorReporter } from './reporter.ts';
import { routePattern } from './routes.ts';

declare const __TRANSCODA_VERSION__: string | undefined;

/** The build's version (vite.config.ts); `unknown` in a test run. */
const VERSION = typeof __TRANSCODA_VERSION__ === 'string' ? __TRANSCODA_VERSION__ : 'unknown';

/** Errors already reported by the React adapter, so the window listener skips them. */
const reported = new WeakSet<object>();

function markReported(error: unknown): void {
  if (typeof error === 'object' && error !== null) reported.add(error);
}

/** sendBeacon survives the page closing; a string body is `text/plain`, which needs no preflight. */
function beacon(body: string): void {
  try {
    if (navigator.sendBeacon?.(CLIENT_ERRORS_PATH, body)) return;
  } catch {
    // Some browsers throw when the queue is full; fall back to fetch.
  }
  fetch(CLIENT_ERRORS_PATH, {
    method: 'POST',
    body,
    keepalive: true,
    credentials: 'same-origin',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
  }).catch(() => undefined);
}

export function createBrowserReporter(): ClientErrorReporter {
  return new ClientErrorReporter({
    send: beacon,
    csrf: csrfToken,
    route: () => routePattern(location.pathname),
    version: VERSION,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
}

/** The page's one reporter. */
export const clientErrors: ClientErrorReporter = createBrowserReporter();

/** An API error's status and code only: the server's message can name a file or a workflow. */
function apiText(e: ORPCError<string, unknown>): string {
  const code = /^[A-Z0-9_]{1,60}$/.test(e.code) ? e.code : 'ERROR';
  return `${e.status} ${code}`;
}

/** What was thrown, as the parts of a report (not yet scrubbed). */
export function describeThrown(kind: ClientErrorKind, thrown: unknown): CapturedError {
  if (thrown instanceof ORPCError) return { kind, name: 'ORPCError', message: apiText(thrown) };
  if (thrown instanceof Error) {
    return { kind, name: thrown.name, message: thrown.message, stack: thrown.stack };
  }
  if (typeof thrown === 'string') return { kind, name: 'Error', message: thrown };
  return { kind, name: 'Error', message: 'A value that is not an Error was thrown' };
}

/**
 * Reports an API call that failed in a way the UI does not expect: anything but the contract's
 * defined errors (which pages show) and an abort. `path` is the procedure (`['jobs', 'list']`).
 */
export function reportApiFailure(
  path: readonly string[],
  error: unknown,
  reporter: ClientErrorReporter = clientErrors,
): void {
  if (error instanceof Error && error.name === 'AbortError') return;
  if (error instanceof ORPCError && error.defined) return;
  const procedure = path.filter((p) => /^[A-Za-z]\w*$/.test(p)).join('.') || 'unknown';
  const what =
    error instanceof ORPCError
      ? apiText(error)
      : error instanceof TypeError
        ? '0 NETWORK'
        : `0 ${error instanceof Error ? error.name : 'ERROR'}`;
  reporter.capture({ kind: 'api', name: 'ApiError', message: `${procedure} ${what}` });
}

/** RPCLink interceptor: reports an unexpected failure, then rethrows it. */
export async function clientErrorInterceptor<T>({
  next,
  path,
}: {
  next: () => Promise<T>;
  path: readonly string[];
}): Promise<T> {
  try {
    return await next();
  } catch (e) {
    reportApiFailure(path, e);
    throw e;
  }
}

/**
 * The React adapter: createRoot's error callback for a render error no error boundary caught
 * (React then unmounts the page). It reports the error and hands it on to the browser as React
 * would by default, so it still shows in the console.
 */
export function reactRootOptions(
  reporter: ClientErrorReporter = clientErrors,
): Pick<RootOptions, 'onUncaughtError'> {
  return {
    onUncaughtError: (error) => {
      markReported(error);
      reporter.capture(describeThrown('render', error));
      if (typeof reportError === 'function') reportError(error);
    },
  };
}

/** A frame for an error the browser gives only a script position for. */
const frameAt = (file: string, line: number, column: number) =>
  file ? `    at ${file}:${line}:${column}` : undefined;

/** Listens for the browser's error events; returns the function that stops listening. */
export function installClientErrors(
  win: Window = window,
  reporter: ClientErrorReporter = clientErrors,
): () => void {
  const onError = (ev: Event) => {
    if (!(ev instanceof ErrorEvent)) return;
    if (typeof ev.error === 'object' && ev.error !== null && reported.has(ev.error)) return;
    const base = describeThrown('error', ev.error ?? ev.message);
    reporter.capture({
      ...base,
      message: base.message || ev.message,
      stack: base.stack ?? frameAt(ev.filename, ev.lineno, ev.colno),
    });
  };
  const onRejection = (ev: PromiseRejectionEvent) => {
    reporter.capture(describeThrown('rejection', ev.reason));
  };
  const onCsp = (ev: SecurityPolicyViolationEvent) => {
    reporter.capture({
      kind: 'csp',
      name: 'SecurityPolicyViolation',
      message: `${ev.effectiveDirective} blocked ${ev.blockedURI || 'inline'}`,
      stack: frameAt(ev.sourceFile, ev.lineNumber, ev.columnNumber),
    });
  };
  const onPageHide = () => reporter.close();
  const onPageShow = () => reporter.reopen();
  const onVisibility = () => {
    if (win.document.visibilityState === 'hidden') reporter.flush();
  };
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  win.document.addEventListener('securitypolicyviolation', onCsp);
  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('pageshow', onPageShow);
  win.document.addEventListener('visibilitychange', onVisibility);
  return () => {
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onRejection);
    win.document.removeEventListener('securitypolicyviolation', onCsp);
    win.removeEventListener('pagehide', onPageHide);
    win.removeEventListener('pageshow', onPageShow);
    win.document.removeEventListener('visibilitychange', onVisibility);
  };
}
