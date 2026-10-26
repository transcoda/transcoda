export const TOKEN_SCOPES = [
  'read',
  'plan',
  'jobs:create',
  'jobs:manage',
  'workflows:write',
] as const;

export type TokenScope = (typeof TOKEN_SCOPES)[number];

export function isTokenScope(value: unknown): value is TokenScope {
  return typeof value === 'string' && (TOKEN_SCOPES as readonly string[]).includes(value);
}
