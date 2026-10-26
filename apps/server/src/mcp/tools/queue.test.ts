import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../test-app.ts';
import { createToken, login } from '../../test-http.ts';
import { mcpClient } from '../test-client.ts';
import { defineTool, mcpNote, NoteInput, ToolFailure, toolsFor } from '../tool.ts';
import { queueTools } from './queue.ts';

const text = (res: unknown) =>
  ((res as { content?: { text: string }[] }).content ?? [])[0]?.text ?? '';

describe('queue tools', () => {
  it('queue_status returns lanes, paused and counts with a one-line summary; pause_queue/resume_queue flip paused and persist', async () => {
    const t = createTestApp({ mcpTools: queueTools });
    await t.deps.engine.start();
    const s = await login(t);
    const { token } = await createToken(t, s, { name: 'm', scopes: ['read', 'jobs:manage'] });
    const client = await mcpClient(t, token);

    const status = await client.callTool({ name: 'queue_status', arguments: {} });
    expect(status.structuredContent).toMatchObject({ paused: false, counts: { queued: 0 } });
    expect(text(status)).toMatch(/^Queue running; encode lane: idle/);

    const paused = await client.callTool({ name: 'pause_queue', arguments: {} });
    expect(paused.structuredContent).toMatchObject({ paused: true });
    expect(text(paused)).toBe('Queue paused.');
    expect(t.deps.engine.scheduler.status().paused).toBe(true);

    const resumed = await client.callTool({ name: 'resume_queue', arguments: {} });
    expect(resumed.structuredContent).toMatchObject({ paused: false });
    expect(t.deps.engine.scheduler.status().paused).toBe(false);
    await t.deps.engine.stop();
  });

  it('a tool whose arguments fail the contract (limit 999 on jobs.list through a throwaway tool) is an isError result, not a transport error', async () => {
    const { z } = await import('zod');
    const badTool = defineTool({
      name: 'bad_list',
      title: 'Bad list',
      description: 'Calls jobs.list with an out-of-range limit.',
      scopes: ['read'],
      annotations: { readOnlyHint: true, openWorldHint: false },
      input: {},
      output: { n: z.number() },
      async run({ api }) {
        await api.jobs.list({ limit: 999 });
        return { text: 'unreachable', data: { n: 0 } };
      },
    });
    const t = createTestApp({ mcpTools: [...queueTools, badTool] });
    const s = await login(t);
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const client = await mcpClient(t, token);
    const res = await client.callTool({ name: 'bad_list', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^BAD_REQUEST: /);
    expect(text(res)).toMatch(/^BAD_REQUEST: /);
  });

  it('toolsFor and mcpNote', () => {
    expect(toolsFor(['read'], queueTools).map((d) => d.name)).toEqual(['queue_status']);
    expect(toolsFor(['jobs:manage'], queueTools).map((d) => d.name)).toEqual([
      'pause_queue',
      'resume_queue',
    ]);
    expect(mcpNote(undefined)).toBe('via MCP');
    expect(mcpNote('x'.repeat(111))).toHaveLength(120);
    expect(NoteInput.safeParse('x'.repeat(112)).success).toBe(false);
  });

  it('a ToolFailure is a text-only isError result with the code, message, hint and data', async () => {
    const { z } = await import('zod');
    const failing = defineTool({
      name: 'failing',
      title: 'Failing',
      description: 'Always fails.',
      scopes: ['read'],
      annotations: { readOnlyHint: true, openWorldHint: false },
      input: {},
      output: { n: z.number() },
      async run() {
        throw new ToolFailure('VERSION_CONFLICT', 'The workflow changed', { currentVersion: 7 });
      },
    });
    const t = createTestApp({ mcpTools: [failing] });
    const s = await login(t);
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const client = await mcpClient(t, token);
    const res = await client.callTool({ name: 'failing', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    expect(text(res)).toBe(
      'VERSION_CONFLICT: The workflow changed\nCall get_workflow and save again with baseVersion 7.\nDetails: {"currentVersion":7}',
    );
  });
});
