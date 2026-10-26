/** A JSON-RPC error body for the HTTP-level refusals of `/mcp` (before any MCP session exists). */
export function jsonRpcError(
  status: number,
  code: number,
  message: string,
  data?: unknown,
  headers: Record<string, string> = {},
): Response {
  const error = { code, message, ...(data !== undefined ? { data } : {}) };
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
