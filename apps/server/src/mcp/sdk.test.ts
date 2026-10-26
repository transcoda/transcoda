import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JobResultSchema,
  NodeInfoSchema,
  RunCountsSchema,
  WorkflowDetailSchema,
} from '@transcoda/contract';
import { emptyGraph, JobStateSchema, WorkflowGraphSchema } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

async function connected(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(clientSide);
  return client;
}

describe('MCP SDK spike', () => {
  it('registers a zod 4 tool taking a workflow graph and answers with structured content; unknown tools and bad arguments are isError results', async () => {
    const server = new McpServer({ name: 'spike', version: '0' });
    server.registerTool(
      'echo_graph',
      {
        description: 'd',
        inputSchema: { graph: WorkflowGraphSchema, note: z.string().max(5).optional() },
        outputSchema: { nodes: z.number().int() },
      },
      async ({ graph }) => ({
        content: [{ type: 'text', text: `${graph.nodes.length}` }],
        structuredContent: { nodes: graph.nodes.length },
      }),
    );
    const client = await connected(server);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo_graph']);
    const inputSchema = tools[0]?.inputSchema as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(inputSchema?.properties).toHaveProperty('graph');
    const res = await client.callTool({
      name: 'echo_graph',
      arguments: { graph: emptyGraph('subworkflow') },
    });
    expect(res.structuredContent).toEqual({ nodes: 2 });
    const bad = await client.callTool({
      name: 'echo_graph',
      arguments: { graph: emptyGraph('workflow'), note: 'toolong' },
    });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toBeUndefined();
    expect((bad.content as { text: string }[])[0]?.text).toMatch(/Input validation error/);
    const missing = await client.callTool({ name: 'nope', arguments: {} });
    expect(missing.isError).toBe(true);
    expect((missing.content as { text: string }[])[0]?.text).toMatch(/Tool nope not found/);
  });

  it('tools/list converts the big output shapes the real tools use', async () => {
    const server = new McpServer({ name: 'spike', version: '0' });
    const outputs = {
      detail: WorkflowDetailSchema.shape,
      node: { node: NodeInfoSchema },
      result: { result: JobResultSchema.nullable() },
      counts: { counts: RunCountsSchema, byState: z.record(JobStateSchema, z.number().int()) },
    };
    for (const [name, outputSchema] of Object.entries(outputs)) {
      server.registerTool(name, { description: 'd', outputSchema }, async () => ({ content: [] }));
    }
    const client = await connected(server);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'counts',
      'detail',
      'node',
      'result',
    ]);
  });
});
