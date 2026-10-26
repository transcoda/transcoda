import type { Route } from '@orpc/contract';

/**
 * OpenAPI override for public operations: an empty `security` list, so generated clients do not
 * demand the document-level bearer token for them.
 */
export const publicSpec: NonNullable<Route['spec']> = (op) => ({ ...op, security: [] });
