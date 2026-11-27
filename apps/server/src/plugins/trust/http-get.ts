import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

const MAX_REDIRECTS = 5;
const NULL_BODY = new Set([101, 204, 205, 304]);

/**
 * A `fetch` for the installer and the catalog built on node:http(s) instead of undici, so an
 * HTTP/1.0 or malformed server gives an ordinary rejection (a `network` failure) and never an
 * uncaught exception. Supports `headers`, `signal` and `redirect: 'manual' | 'follow'` (default
 * follow, at most 5 hops, same rules as `fetch`: the body is streamed, the caller caps its size).
 */
export const httpFetch: typeof fetch = async (input, init) => {
  let current = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    headers[k] = v;
  });
  const signal = init?.signal ?? undefined;
  const manual = init?.redirect === 'manual';
  for (let hop = 0; ; hop++) {
    const res = await once(current, headers, signal);
    const location = res.headers.get('location');
    if (!manual && res.status >= 300 && res.status < 400 && location !== null) {
      await res.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
      current = new URL(location, current).href;
      continue;
    }
    return res;
  }
};

function once(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error('invalid url'));
      return;
    }
    const send =
      target.protocol === 'https:'
        ? httpsRequest
        : target.protocol === 'http:'
          ? httpRequest
          : null;
    if (send === null) {
      reject(new Error(`unsupported scheme ${target.protocol}`));
      return;
    }
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const req = send(target, { method: 'GET', headers, agent: false }, (res: IncomingMessage) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
      }
      const status = res.statusCode ?? 0;
      if (status < 200 || status > 599) {
        res.destroy();
        reject(new Error(`bad status ${status}`));
        return;
      }
      res.on('error', () => undefined);
      if (NULL_BODY.has(status)) {
        res.resume();
        resolve(new Response(null, { status, headers: h }));
        return;
      }
      // A stream error after the headers is a rejected read, not an uncaught exception.
      resolve(
        new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers: h }),
      );
    });
    const onAbort = (): void => {
      req.destroy(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    req.on('error', (err) => reject(err));
    req.end();
  });
}
