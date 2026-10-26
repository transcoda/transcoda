import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp } from '../test-app.ts';
import { asSession, bearer, createToken, HOST, login, send } from '../test-http.ts';
import { INITIALIZE, mcpClient, rawMcp } from './test-client.ts';
import { defineTool, ToolFailure } from './tool.ts';
import { queueTools } from './tools/queue.ts';

const names = (r: { tools: { name: string }[] }) => r.tools.map((t) => t.name);
const errorBody = async (res: Response) =>
  (await res.json()) as { error: { code: number; message: string; data?: { host?: string } } };

describe('/mcp handler', () => {
  it('GET and DELETE /mcp are 405 with Allow: POST; a POST without a bearer is 401 with WWW-Authenticate; a session cookie alone is 401', async () => {
    const t = createTestApp({ mcpTools: queueTools });
    const s = await login(t);
    for (const method of ['GET', 'DELETE']) {
      const res = await rawMcp(t, INITIALIZE, {}, method);
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect((await errorBody(res)).error.code).toBe(-32000);
    }
    const anon = await rawMcp(t, INITIALIZE);
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toBe('Bearer realm="transcoda"');
    expect((await errorBody(anon)).error.message).toMatch(/^Authentication required/);
    expect((await rawMcp(t, INITIALIZE, asSession(s, false))).status).toBe(401);
  });

  it('a read token initialises and lists only read tools; a jobs:manage token sees pause_queue/resume_queue too; a revoked token is 401 on the next call', async () => {
    const t = createTestApp({ mcpTools: queueTools });
    const s = await login(t);
    const read = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const manage = await createToken(t, s, { name: 'm', scopes: ['read', 'jobs:manage'] });
    const readClient = await mcpClient(t, read.token);
    expect(names(await readClient.listTools())).toEqual(['queue_status']);
    const manageClient = await mcpClient(t, manage.token);
    expect(names(await manageClient.listTools())).toEqual([
      'queue_status',
      'pause_queue',
      'resume_queue',
    ]);
    const revoked = await send(t, 'DELETE', `/tokens/${read.id}`, { headers: asSession(s, true) });
    expect(revoked.status).toBe(200);
    await expect(readClient.listTools()).rejects.toThrow();
    // The other token is unaffected: auth is per request.
    expect(names(await manageClient.listTools())).toHaveLength(3);
  });

  it('a hidden tool is refused: calling pause_queue with a read token resolves to an isError result "Tool pause_queue not found" without structuredContent; the queue stays running', async () => {
    const t = createTestApp({ mcpTools: queueTools });
    const s = await login(t);
    const read = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const client = await mcpClient(t, read.token);
    const res = await client.callTool({ name: 'pause_queue', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]?.text).toMatch(/Tool pause_queue not found/);
    expect(res.structuredContent).toBeUndefined();
    expect(t.deps.engine.scheduler.status().paused).toBe(false);
  });

  it('host check: an unknown Host is 403 with a JSON-RPC body; Origin from another site is 403; absent Origin passes', async () => {
    const t = createTestApp({ mcpTools: queueTools });
    const s = await login(t);
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const badHost = await rawMcp(t, INITIALIZE, { ...bearer(token), host: 'evil.example:8080' });
    expect(badHost.status).toBe(403);
    expect((await errorBody(badHost)).error.data?.host).toBe('evil.example');
    const badOrigin = await rawMcp(t, INITIALIZE, {
      ...bearer(token),
      origin: 'http://evil.example',
    });
    expect(badOrigin.status).toBe(403);
    expect((await errorBody(badOrigin)).error.message).toBe('Origin not allowed');
    expect((await rawMcp(t, INITIALIZE, bearer(token))).status).toBe(200);
  });

  it('bodies over 2 MiB are 413 as a JSON-RPC error; no Mcp-Session-Id is ever issued', async () => {
    const t = createTestApp({ mcpTools: queueTools });
    const s = await login(t);
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const big = await rawMcp(t, `"${'x'.repeat(2 * 1024 * 1024)}"`, bearer(token));
    expect(big.status).toBe(413);
    expect((await errorBody(big)).error.code).toBe(-32600);
    const ok = await rawMcp(t, INITIALIZE, bearer(token));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('mcp-session-id')).toBeNull();
    const body = (await ok.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('transcoda');
  });

  it("a bearer token with a session cookie ignores the cookie: the token's scopes apply", async () => {
    const t = createTestApp({ mcpTools: queueTools });
    const s = await login(t); // the session is a full user
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const client = await mcpClient(t, token, asSession(s, false));
    expect(names(await client.listTools())).toEqual(['queue_status']);
  });

  it('an oversized body without content-length (a stream) is a JSON-RPC 413 before any tool runs', async () => {
    let ran = false;
    const probe = defineTool({
      name: 'probe',
      title: 'Probe',
      description: 'Records that it ran.',
      scopes: ['read'],
      annotations: { readOnlyHint: true, openWorldHint: false },
      input: {},
      output: { ok: z.boolean() },
      async run() {
        ran = true;
        return { text: 'ran', data: { ok: true } };
      },
    });
    const t = createTestApp({ mcpTools: [probe] });
    const s = await login(t);
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const chunk = new TextEncoder().encode('x'.repeat(256 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 10) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const res = await t.app.request('/mcp', {
      method: 'POST',
      headers: {
        host: HOST,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...bearer(token),
      },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect((await errorBody(res)).error.code).toBe(-32600);
    expect(ran).toBe(false);
  });

  it('every failure code resolves on a client that listed tools first (no -32602 from output validation): isError, text with code and hint, no structuredContent', async () => {
    const cases: [string, unknown, string][] = [
      ['VERSION_CONFLICT', { currentVersion: 4 }, 'save again with baseVersion 4'],
      [
        'PATH_REJECTED',
        { reason: 'outside the library', path: '/x/y' },
        'outside the library: /x/y',
      ],
      ['HIDDEN_URL_UNKNOWN', { nodeIds: ['n1'] }, 'Enter a full webhook URL in node(s) n1'],
      ['IN_USE', { usedBy: [{ id: 'w1', name: 'Parent' }] }, 'Used by: Parent (w1)'],
      ['NOT_FOUND', undefined, 'NOT_FOUND: failing'],
      ['JOB_NOT_ACTIVE', undefined, 'JOB_NOT_ACTIVE: failing'],
      ['KIND_MISMATCH', undefined, 'KIND_MISMATCH: failing'],
      ['INTERNAL', undefined, 'INTERNAL: Transcoda could not complete'],
    ];
    const tools = cases.map(([code, data]) =>
      defineTool({
        name: `fail_${code.toLowerCase()}`,
        title: code,
        description: 'Always fails.',
        scopes: ['read'],
        annotations: { readOnlyHint: true, openWorldHint: false },
        input: {},
        output: { n: z.number() },
        async run() {
          if (code === 'INTERNAL') throw new Error('boom');
          throw new ToolFailure(code, 'failing', data);
        },
      }),
    );
    const t = createTestApp({ mcpTools: tools });
    const s = await login(t);
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const client = await mcpClient(t, token);
    await client.listTools(); // arms the SDK client's output-schema validation
    for (const [code, , expected] of cases) {
      const res = await client.callTool({ name: `fail_${code.toLowerCase()}`, arguments: {} });
      const body = (res.content as { text: string }[])[0]?.text ?? '';
      expect(res.isError, code).toBe(true);
      expect(res.structuredContent, code).toBeUndefined();
      expect(body, code).toContain(code);
      expect(body, code).toContain(expected);
    }
  });

  it('advertises tools.listChanged false', async () => {
    const t = createTestApp({ mcpTools: queueTools });
    const s = await login(t);
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const client = await mcpClient(t, token);
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
  });
});
