// Shared setup for the FetchProxy tests (fetch-proxy*.test.ts): a local HTTP server whose answer a
// test sets with setHandler, its request counters, and a proxy over it.
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_LIMITS, type FetchInput } from '@transcoda/shared';
import { afterEach, beforeEach } from 'vitest';
import { type AddressKind, classifyAddress } from './address-policy.ts';
import { FetchProxy, type FetchProxyDeps } from './fetch-proxy.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export let server: Server;
export let origin = '';
let handler: Handler = (_req, res) => res.end();
export let requests = 0;
let inFlight = 0;
export let maxInFlight = 0;

export const input = (url: string, extra: Partial<FetchInput> = {}): FetchInput => ({
  url,
  method: 'GET',
  headers: {},
  accept: 'json',
  ...extra,
});

/**
 * The test servers listen on loopback, which the proxy always refuses. Most tests stand in for a
 * LAN service: loopback counts as a private address, and every name resolves to a LAN address.
 */
export const lanClassify = (ip: string): AddressKind =>
  ip === '127.0.0.1' || ip === '::1' ? 'private' : classifyAddress(ip);
export const lan: Pick<FetchProxyDeps, 'classify' | 'resolve'> = {
  classify: lanClassify,
  resolve: async () => [{ address: '192.168.1.5', family: 4 }],
};

export const proxy = (
  limits: Partial<FetchProxyDeps['limits']> = {},
  deps: Partial<FetchProxyDeps> = {},
) => {
  const p = new FetchProxy('sonarr', {
    limits: { ...DEFAULT_LIMITS, ...limits },
    ...lan,
    ...deps,
  });
  p.setPolicy({ allowedOrigins: [origin], allowInsecureTls: false });
  return p;
};

/** What the test server answers with, from now until the next test. */
export function setHandler(next: Handler): void {
  handler = next;
}

/** Resets the test server's request count. */
export function setRequests(n: number): void {
  requests = n;
}

/** Registers the setup and teardown every test in these files shares. */
export function useTestServer(): void {
  beforeEach(async () => {
    requests = 0;
    inFlight = 0;
    maxInFlight = 0;
    handler = (_req, res) => res.end();
    server = createServer((req, res) => {
      requests += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      res.on('close', () => {
        inFlight -= 1;
      });
      handler(req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    // Late 'close' events of the old server's responses must not leak into the next test's counters.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
