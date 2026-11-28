// A plugin trigger's webhook (docs/dev/plugins-host.md, "Triggers"): Sonarr or Radarr, say, posts
// its own JSON here and the plugin says which files it names. Everything in the request and in the
// plugin's answer is untrusted; files are queued by the same rules as `jobs.queue`.
import { isAbsolute } from 'node:path';
import type { JsonValue } from '@transcoda/shared';
import type { Context } from 'hono';
import { hasScope } from '../auth/tokens.ts';
import type { QueueResult } from '../engine/queue/queue-service.ts';
import type { PluginService } from '../plugins/service/service.ts';
import type { AppDeps } from '../rpc/context.ts';

type PluginTrigger = NonNullable<ReturnType<PluginService['trigger']>>;
type TriggerAuth = PluginTrigger['auth'];
type TriggerRequest = Parameters<PluginTrigger['call']>[0];

/** Under `/api`, so the host check and the body limit apply; not part of the contract. */
export const TRIGGER_PATH = '/api/triggers/:plugin/:trigger';

const MAX_HEADERS = 64;
const MAX_HEADER_CHARS = 4096;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Headers that carry credentials: never passed to a plugin. */
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

/**
 * The API token a trigger request carries, or null: the trigger's own header when it declares one,
 * else `Authorization`, as a Bearer token or as the password of Basic auth (the user name is not
 * read; Sonarr and Radarr have a user name and a password field). Never throws.
 */
export function triggerToken(headers: Headers, auth: TriggerAuth | null): string | null {
  if (auth && 'header' in auth) {
    const own = headers.get(auth.header)?.trim();
    if (own) return own;
  }
  const authorization = headers.get('authorization')?.trim() ?? '';
  const [scheme = '', value = '', ...rest] = authorization.split(/\s+/);
  if (rest.length > 0 || value === '') return null;
  if (scheme.toLowerCase() === 'bearer') return value;
  if (scheme.toLowerCase() !== 'basic' || !BASE64.test(value)) return null;
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const password = colon === -1 ? '' : decoded.slice(colon + 1);
  return password === '' ? null : password;
}

/** The request headers a plugin sees: lower-case names, without credentials, bounded. */
export function triggerHeaders(headers: Headers, auth: TriggerAuth | null): Record<string, string> {
  const hidden = new Set(SECRET_HEADERS);
  if (auth && 'header' in auth) hidden.add(auth.header.toLowerCase());
  const out: Record<string, string> = {};
  let n = 0;
  headers.forEach((value, name) => {
    if (n >= MAX_HEADERS || hidden.has(name) || value.length > MAX_HEADER_CHARS) return;
    out[name] = value;
    n += 1;
  });
  return out;
}

/** What happened to one file the trigger named. */
export interface TriggerFileResult {
  path: string;
  note: string;
  /** The job's state (`queued`, `already_processed`, `skipped`, …), or `rejected` with no job. */
  state: string;
  jobId: string | null;
  reason: string | null;
}

const rejected = (reason: string) => ({ state: 'rejected', jobId: null, reason });

function describe(
  r: Exclude<QueueResult, { kind: 'queued' }>,
): Pick<TriggerFileResult, 'state' | 'jobId' | 'reason'> {
  switch (r.kind) {
    case 'path-rejected':
      return rejected(r.reason);
    case 'no-feeding-workflow':
      return rejected('no active workflow feeds this library');
    case 'workflow-invalid':
      return rejected('the workflow that feeds this library is invalid');
    case 'workflow-missing':
    case 'version-missing':
      return rejected('the workflow that feeds this library has no active version');
  }
}

async function queueFile(
  deps: AppDeps,
  path: string,
  createdBy: string,
): Promise<Pick<TriggerFileResult, 'state' | 'jobId' | 'reason'>> {
  // Only an absolute path is looked up; a relative one would resolve against the server's cwd.
  if (!isAbsolute(path) || path.includes('\0')) return rejected('not an absolute path');
  const r = await deps.engine.queue.queue({
    path,
    dryRun: false,
    force: false,
    fileOnly: true,
    priority: 0,
    createdBy,
  });
  if (r.kind !== 'queued') return describe(r);
  const job = r.jobs[0];
  if (!job) return rejected('nothing to queue');
  return { state: job.state, jobId: job.id, reason: job.reason };
}

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 502 | 503,
  code: string,
  message: string,
) =>
  c.json(
    { code, message },
    status,
    status === 401 ? { 'www-authenticate': 'Basic realm="transcoda"' } : {},
  );

/**
 * Answers a trigger webhook. A token with `jobs:create` (sessions are not accepted, so there is no
 * CSRF question); then the plugin reads the body; then each file it names is queued, only when it
 * is inside a library, through the workflow that feeds that library.
 */
export async function triggerResponse(c: Context, deps: AppDeps): Promise<Response> {
  const pluginName = c.req.param('plugin') ?? '';
  const triggerId = c.req.param('trigger') ?? '';
  const trigger = deps.plugins.trigger(pluginName, triggerId);
  const token = triggerToken(c.req.raw.headers, trigger?.auth ?? null);
  const found = token === null ? null : deps.tokens.authenticate(token);
  if (!found) return problem(c, 401, 'UNAUTHORIZED', 'A valid API token is required');
  if (!hasScope(found.scopes, 'jobs:create')) {
    return problem(c, 403, 'FORBIDDEN', 'The token needs the jobs:create scope');
  }
  if (!trigger) return problem(c, 404, 'NOT_FOUND', 'No such trigger');

  let body: JsonValue;
  try {
    body = JSON.parse(await c.req.text()) as JsonValue;
  } catch {
    return problem(c, 400, 'BAD_REQUEST', 'The body must be JSON');
  }
  const request: TriggerRequest = {
    method: c.req.method,
    headers: triggerHeaders(c.req.raw.headers, trigger.auth),
    body,
  };
  const called = await trigger.call(request);
  const where = { plugin: pluginName, trigger: triggerId };
  if (!called.ok) {
    deps.log.warn({ msg: 'trigger failed', ...where, kind: called.kind });
    return called.kind === 'unavailable'
      ? problem(c, 503, 'PLUGIN_UNAVAILABLE', called.message)
      : problem(c, 502, 'TRIGGER_FAILED', called.message);
  }
  const { answer } = called;
  if (answer.kind === 'test') return c.json({ kind: 'test', message: answer.message });
  if (answer.kind === 'ignore') return c.json({ kind: 'ignore', reason: answer.reason });

  const files: TriggerFileResult[] = [];
  for (const f of answer.files) {
    files.push({ path: f.path, note: f.note, ...(await queueFile(deps, f.path, found.user.id)) });
  }
  const refused = files.filter((f) => f.state === 'rejected').length;
  // Counts only: paths and the body stay out of the log (docs/dev/server-api.md, "Logging").
  deps.log.info({ msg: 'trigger', ...where, files: files.length, refused });
  return c.json({ kind: 'files', files });
}
