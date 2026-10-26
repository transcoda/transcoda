import { SmartCoercionPlugin } from '@orpc/json-schema';
import { OpenAPIGenerator } from '@orpc/openapi';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { ORPCError, onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { ResponseHeadersPlugin } from '@orpc/server/plugins';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { contract } from '@transcoda/contract';
import type { Logger } from '../logger.ts';
import type { ServerContext } from './context.ts';
import type { Router } from './router.ts';

export interface Handlers {
  rpc: RPCHandler<ServerContext>;
  openapi: OpenAPIHandler<ServerContext>;
  spec: () => Promise<object>;
}

/**
 * Logs a procedure failure once when it is unexpected: not an ORPCError, or an undefined
 * ORPCError with a 5xx status (e.g. an output that fails its schema). Only the procedure path
 * and the error's name and message are logged, never input or context.
 */
function logUnexpected(log: Logger) {
  return (error: unknown, { path }: { path: readonly string[] }): void => {
    if (error instanceof ORPCError && (error.defined || error.status < 500)) return;
    log.error({
      msg: 'rpc procedure failed',
      procedure: path.join('.'),
      error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error',
    });
  };
}

export function createHandlers(router: Router, version: string, log: Logger): Handlers {
  const converters = [new ZodToJsonSchemaConverter()];
  // A fresh array per handler: oRPC plugins add their own interceptors to it.
  const rpc = new RPCHandler<ServerContext>(router, {
    plugins: [new ResponseHeadersPlugin()],
    clientInterceptors: [onError(logUnexpected(log))],
  });
  const openapi = new OpenAPIHandler<ServerContext>(router, {
    clientInterceptors: [onError(logUnexpected(log))],
    plugins: [
      new ResponseHeadersPlugin(),
      new SmartCoercionPlugin({ schemaConverters: converters }),
    ],
  });

  let cached: Promise<object> | undefined;
  const spec = () => {
    cached ??= new OpenAPIGenerator({ schemaConverters: converters }).generate(contract, {
      info: { title: 'Transcoda API', version },
      servers: [{ url: '/api/v1' }],
      security: [{ bearerAuth: [] }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    });
    return cached;
  };

  return { rpc, openapi, spec };
}
