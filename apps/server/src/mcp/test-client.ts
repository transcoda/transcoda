import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { TestApp } from '../test-app.ts';
import { HOST } from '../test-http.ts';

const withHost = (init?: RequestInit): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set('host', HOST);
  return { ...init, headers };
};

/** An MCP client over `app.request` (no socket), authenticating with `token`. */
export async function mcpClient(
  t: TestApp,
  token: string,
  headers: Record<string, string> = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080/mcp'), {
    fetch: (url, init) => Promise.resolve(t.app.request(url.toString(), withHost(init))),
    requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } },
  });
  const client = new Client({ name: 'test', version: '0' });
  // The SDK's transport class declares `sessionId?: string | undefined`, which
  // exactOptionalPropertyTypes rejects against its own Transport interface.
  await client.connect(transport as Transport);
  return client;
}

/** A raw request to `/mcp` (a string body is sent as is, anything else is JSON). */
export async function rawMcp(
  t: TestApp,
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<Response> {
  const hasBody = method !== 'GET' && method !== 'DELETE';
  return t.app.request('/mcp', {
    method,
    headers: {
      host: HOST,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    ...(hasBody ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

export const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};
