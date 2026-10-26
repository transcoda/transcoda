import { IssueSchema } from '@transcoda/shared';
import { z } from 'zod';
import { LibraryRefSchema } from './schemas/libraries.ts';
import { HealthChecksSchema } from './schemas/system.ts';
import { WorkflowRefSchema } from './schemas/workflows.ts';

/**
 * Every error code the API can raise, defined once. Procedures pick the subset
 * they can actually raise with `pickErrors`, so no error map is copy-pasted.
 */
export const errorDefs = {
  UNAUTHORIZED: { status: 401, message: 'Authentication required' },
  FORBIDDEN: { status: 403, message: 'Insufficient permissions' },
  INVALID_CREDENTIALS: { status: 401, message: 'Invalid username or password' },
  SETUP_ALREADY_DONE: { status: 409, message: 'Setup has already been completed' },
  RATE_LIMITED: {
    status: 429,
    message: 'Too many attempts',
    data: z.object({ retryAfterSeconds: z.number() }),
  },
  NOT_FOUND: { status: 404, message: 'Not found' },
  CSRF_FAILED: { status: 403, message: 'CSRF token missing or invalid' },
  /** Raised by the server's host check before routing; `data.host` is the rejected hostname. */
  HOST_NOT_ALLOWED: {
    status: 403,
    message: 'Host not allowed',
    data: z.object({ host: z.string() }),
  },
  INVALID_EXPIRY: { status: 400, message: 'Token expiry must be a valid time in the future' },
  VERSION_CONFLICT: {
    status: 409,
    message: 'The workflow was changed since you loaded it',
    data: z.object({ currentVersion: z.number().int() }),
  },
  /** The saved graph's kind differs from the workflow's kind. */
  KIND_MISMATCH: { status: 400, message: 'The graph kind does not match the workflow kind' },
  /**
   * A webhook URL sent back in its redacted form (`scheme://host/…`) that matches no stored value of
   * the same node in any version of the workflow; `nodeIds` are the nodes to enter the URL again in.
   */
  HIDDEN_URL_UNKNOWN: {
    status: 400,
    message: 'A hidden webhook URL could not be matched to a saved one. Enter the URL again.',
    data: z.object({ nodeIds: z.array(z.string()) }),
  },
  WORKFLOW_INVALID: {
    status: 422,
    message: 'The workflow has errors',
    data: z.object({ issues: z.array(IssueSchema) }),
  },
  IN_USE: {
    status: 409,
    message: 'The sub-workflow is used by other workflows',
    data: z.object({ usedBy: z.array(WorkflowRefSchema) }),
  },
  /** A path the engine will not touch; `reason` is human text such as `outside library root`. */
  PATH_REJECTED: {
    status: 400,
    message: 'The path cannot be used',
    data: z.object({ path: z.string(), reason: z.string() }),
  },
  LIBRARY_PATH_INVALID: {
    status: 400,
    message: 'The library path cannot be used',
    data: z.object({ reason: z.string() }),
  },
  LIBRARY_BUSY: { status: 409, message: 'The library has active jobs' },
  /** Activation: the version's Library input names a library another active workflow feeds from. */
  LIBRARY_TAKEN: {
    status: 409,
    message: 'Another active workflow already takes files from this library',
    data: z.object({
      library: LibraryRefSchema,
      workflow: z.object({ id: z.string(), name: z.string(), version: z.number().int() }),
    }),
  },
  /** Activation: the version's Library input names no existing library. */
  LIBRARY_MISSING: {
    status: 400,
    message: 'Library input: no library with this id',
    data: z.object({ libraryId: z.string() }),
  },
  NO_FEEDING_WORKFLOW: {
    status: 400,
    message: 'No workflow given and no active workflow takes files from this library',
  },
  PLUGIN_INSTALL_FAILED: {
    status: 422,
    message: 'The plugin could not be installed',
    data: z.object({ reason: z.string() }),
  },
  PLUGIN_SETTINGS_INVALID: {
    status: 422,
    message: 'The settings are not valid',
    data: z.object({
      issues: z.array(z.object({ path: z.string(), message: z.string(), missing: z.boolean() })),
    }),
  },
  PLUGIN_NOT_RUNNING: {
    status: 409,
    message: 'The plugin is not running',
    data: z.object({ reason: z.string() }),
  },
  /** A failed deep health check (`?deep=1`): check names and ok/fail only, never a path or message. */
  UNHEALTHY: {
    status: 503,
    message: 'Unhealthy',
    data: z.object({
      status: z.literal('fail'),
      version: z.string(),
      checks: HealthChecksSchema,
    }),
  },
  JOB_NOT_ACTIVE: { status: 409, message: 'The job is not in a state that allows this' },
} as const;

export type ErrorCode = keyof typeof errorDefs;

export function pickErrors<const K extends ErrorCode>(...codes: K[]): Pick<typeof errorDefs, K> {
  const out = {} as Pick<typeof errorDefs, K>;
  for (const code of codes) out[code] = errorDefs[code];
  return out;
}

/** Error sets shared by groups of procedures. */
export const authedErrors = pickErrors('UNAUTHORIZED', 'FORBIDDEN');
export const mutationErrors = pickErrors('UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED');
