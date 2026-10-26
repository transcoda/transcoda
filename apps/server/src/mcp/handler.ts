import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createRouterClient, ORPCError } from '@orpc/server';
import type { Context } from 'hono';
import { z } from 'zod';
import { checkOrigin } from '../http/host-check.ts';
import type { Logger } from '../logger.ts';
import type { AppDeps, ServerContext } from '../rpc/context.ts';
import type { Router } from '../rpc/router.ts';
import { INSTRUCTIONS } from './instructions.ts';
import { jsonRpcError } from './jsonrpc.ts';
import { type AnyToolDef, type TokenAuth, ToolFailure, toolsFor } from './tool.ts';

export const SERVER_NAME = 'transcoda';

const INTERNAL_MESSAGE = 'Transcoda could not complete the call; see the server log';

export interface McpHandlerOptions {
  router: Router;
  deps: AppDeps;
  version: string;
  log: Logger;
  tools: AnyToolDef[];
  getRemoteAddr: (c: Context) => string;
}

interface ToolError {
  code: string;
  message: string;
  data?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** One hint line for the codes an agent can act on; empty when there is nothing to add. */
function hintFor(error: ToolError): string {
  const data = asRecord(error.data);
  switch (error.code) {
    case 'VERSION_CONFLICT':
      return data.currentVersion === undefined
        ? ''
        : `Call get_workflow and save again with baseVersion ${String(data.currentVersion)}.`;
    case 'HIDDEN_URL_UNKNOWN': {
      const ids = Array.isArray(data.nodeIds) ? data.nodeIds.map(String) : [];
      return ids.length === 0 ? '' : `Enter a full webhook URL in node(s) ${ids.join(', ')}.`;
    }
    case 'IN_USE': {
      const usedBy = Array.isArray(data.usedBy) ? data.usedBy.map(asRecord) : [];
      return usedBy.length === 0
        ? ''
        : `Used by: ${usedBy.map((n) => `${String(n.name)} (${String(n.id)})`).join(', ')}.`;
    }
    case 'WORKFLOW_INVALID': {
      const issues = Array.isArray(data.issues) ? data.issues.map(asRecord) : [];
      return issues
        .map(
          (i) =>
            `- ${String(i.severity)} ${String(i.code)}${i.nodeId ? ` on ${String(i.nodeId)}` : ''}: ${String(i.message)}`,
        )
        .join('\n');
    }
    case 'PATH_REJECTED':
      return data.reason === undefined || data.path === undefined
        ? ''
        : `${String(data.reason)}: ${String(data.path)}`;
    case 'FORBIDDEN':
      return 'The token lacks a scope this needs.';
    default:
      return '';
  }
}

/**
 * A tool error as a text-only result. No `structuredContent`: an SDK client validates it
 * against the tool's outputSchema even when `isError` is set and would turn the failure
 * into a -32602 protocol error. The code, message, hint and data travel in the text.
 */
function errorResult(error: ToolError) {
  const hint = hintFor(error);
  const lines = [`${error.code}: ${error.message}`];
  if (hint !== '') lines.push(hint);
  const data = asRecord(error.data);
  const skipData = error.code === 'WORKFLOW_INVALID' || Object.keys(data).length === 0;
  if (!skipData) lines.push(`Details: ${JSON.stringify(data)}`);
  return { isError: true as const, content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

export function createMcpHandler(opts: McpHandlerOptions): (c: Context) => Promise<Response> {
  const { router, deps, version, log, tools, getRemoteAddr } = opts;

  return async (c) => {
    if (c.req.method !== 'POST') {
      return jsonRpcError(405, -32000, 'Method not allowed.', undefined, { allow: 'POST' });
    }

    const match = /^\s*bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '');
    const found = match?.[1] ? deps.tokens.authenticate(match[1]) : null;
    if (!found) {
      return jsonRpcError(
        401,
        -32000,
        'Authentication required: send Authorization: Bearer <API token>',
        undefined,
        { 'www-authenticate': 'Bearer realm="transcoda"' },
      );
    }

    if (checkOrigin(c.req.raw, deps.allowedHosts()) === 'mismatch') {
      return jsonRpcError(403, -32000, 'Origin not allowed');
    }

    const auth: TokenAuth = {
      kind: 'token',
      user: found.user,
      tokenId: found.tokenId,
      scopes: found.scopes,
    };
    const context: ServerContext = { req: c.req.raw, remoteAddr: getRemoteAddr(c), auth, deps };
    const api = createRouterClient(router, { context });

    const server = new McpServer({ name: SERVER_NAME, version }, { instructions: INSTRUCTIONS });
    for (const def of toolsFor(auth.scopes, tools)) {
      server.registerTool(
        def.name,
        {
          title: def.title,
          description: def.description,
          inputSchema: def.strict ? z.strictObject(def.input) : def.input,
          outputSchema: def.output,
          annotations: def.annotations,
        },
        async (args: unknown) => {
          const logCall = (ok: boolean, code?: string) =>
            log.info({
              msg: 'mcp tool call',
              tool: def.name,
              tokenId: auth.tokenId,
              ok,
              ...(code ? { code } : {}),
            });
          try {
            const { text, data } = await def.run(
              { api, deps, auth },
              args as Record<string, unknown>,
            );
            logCall(true);
            return { content: [{ type: 'text' as const, text }], structuredContent: data };
          } catch (e) {
            if (e instanceof ToolFailure || (e instanceof ORPCError && e.status < 500)) {
              logCall(false, e.code);
              return errorResult({ code: e.code, message: e.message, data: e.data });
            }
            // The error name only: a message may echo input (a webhook URL).
            log.error({
              msg: 'mcp tool failed',
              tool: def.name,
              error: e instanceof Error ? e.name : 'unknown error',
            });
            logCall(false, 'INTERNAL');
            return errorResult({ code: 'INTERNAL', message: INTERNAL_MESSAGE });
          }
        },
      );
    }

    // Stateless: this transport can never send tools/list_changed.
    if (toolsFor(auth.scopes, tools).length > 0) {
      server.server.registerCapabilities({ tools: { listChanged: false } });
    }

    // Stateless: no session id generator; one server and transport per request.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  };
}
