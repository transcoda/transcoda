import { createORPCClient, isDefinedError, safe } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ApiClient } from '@transcoda/contract';
import { csrfHeaders } from './csrf.ts';
import { hostGuardInterceptor } from './host-guard.ts';

export const api: ApiClient = createORPCClient(
  new RPCLink({
    url: `${location.origin}/rpc`,
    headers: () => csrfHeaders(),
    interceptors: [hostGuardInterceptor],
  }),
);

export { isDefinedError, safe };
