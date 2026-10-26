import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import {
  type FetchFailure,
  type FetchInput,
  type FetchOutput,
  type FetchPolicy,
  type FetchResult,
  type JsonValue,
  SECRET_PLACEHOLDER,
  type SupervisorLimits,
} from '@transcoda/shared';
import { type SecretEncoding, sanitizeSecretPath } from '../plugin-host/redact.ts';
import {
  type AddressKind,
  addressVerdict,
  classifyAddress,
  isPrivateHost,
} from './address-policy.ts';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface FetchProxyDeps {
  limits: Pick<
    SupervisorLimits,
    | 'fetchDefaultTimeoutMs'
    | 'fetchMaxTimeoutMs'
    | 'fetchConcurrency'
    | 'fetchPerSecond'
    | 'fetchBodyBytes'
  >;
  now?: () => number;
  /** Waits for the token bucket and Retry-After; tests inject a fake clock. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  request?: typeof import('node:https').request;
  requestHttp?: typeof import('node:http').request;
  /** Name resolution, once per hop; tests inject a fake resolver (DNS rebinding). */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Address classification; tests stand a loopback server in for a LAN or public one. */
  classify?: (address: string) => AddressKind;
}

const defaultResolve = (hostname: string): Promise<ResolvedAddress[]> =>
  dnsLookup(hostname, { all: true, verbatim: true });

const MAX_REDIRECTS = 5;
const MAX_RETRY_AFTER_MS = 60_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETURNED_HEADERS = [
  'content-type',
  'content-length',
  'retry-after',
  'location',
  'x-request-id',
  'etag',
];
/** Set by the server, never by the plugin. */
const MAX_QUEUED = 100;
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'keep-alive',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'expect',
]);

/** Same grammar as the host's tokenizer (plugin-host/redact.ts). */
const TOKEN_PATTERN = /__TRANSCODA_SECRET__([A-Za-z0-9_.]+?)__(raw|url|form|b64|b64url)__/g;
const MAX_ECHOED_FIELD_CHARS = 100;

const encodeSecret = (value: string, enc: SecretEncoding): string => {
  switch (enc) {
    case 'raw':
      return value;
    case 'url':
      return encodeURIComponent(value);
    case 'form':
      return new URLSearchParams([['', value]]).toString().slice(1);
    case 'b64':
      return Buffer.from(value).toString('base64');
    case 'b64url':
      return Buffer.from(value).toString('base64url');
  }
};

/** Keys are sanitised like the tokens' field paths; two real paths that collide are refused. */
function secretMap(values: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  const origin = new Map<string, string>();
  for (const [path, value] of Object.entries(values)) {
    const key = sanitizeSecretPath(path);
    if (key.includes('__')) {
      throw new Error(`secret field "${path}" contains "__", which is ambiguous in tokens`);
    }
    const earlier = origin.get(key);
    if (earlier !== undefined && earlier !== path) {
      throw new Error(`secret fields "${earlier}" and "${path}" are ambiguous`);
    }
    origin.set(key, path);
    map.set(key, value);
  }
  return map;
}

const mapJson = (value: JsonValue, fn: (s: string) => string): JsonValue => {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapJson(item, fn));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = mapJson(item, fn);
    }
    return out;
  }
  return value;
};

/**
 * Puts the real secret values back into url, header values, body and auth. Throws a `Failure` (the
 * field name only, never a value) for a token that names a field the plugin does not own. Nothing
 * is sent anywhere before this has finished for the whole input. Responses are not scanned: a
 * service that echoes the key back hands it to the plugin (accepted, see the plugin docs).
 */
function substituteInput(input: FetchInput, secrets: Map<string, string>): FetchInput {
  if (input.auth && 'header' in input.auth) {
    const name = input.auth.header.name;
    if (DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) {
      throw new Failure(fail('refused', `header "${name}" cannot be set`));
    }
  }
  if (JSON.stringify(input).includes(SECRET_PLACEHOLDER)) {
    throw new Failure(
      fail(
        'refused',
        `the request contains ${SECRET_PLACEHOLDER}, a secret that could not be recognised: send credentials with auth, and use a structured JSON body instead of a pre-serialised string`,
      ),
    );
  }
  const one = (text: string): string =>
    text.replace(TOKEN_PATTERN, (_hit, field: string, enc: SecretEncoding) => {
      const value = secrets.get(field);
      if (value === undefined) {
        const shown =
          field.length > MAX_ECHOED_FIELD_CHARS
            ? `${field.slice(0, MAX_ECHOED_FIELD_CHARS)}...`
            : field;
        throw new Failure(
          fail('refused', `secret "${shown}" is not a secret field of this integration`),
        );
      }
      return encodeSecret(value, enc);
    });
  const out: FetchInput = {
    ...input,
    url: one(input.url),
    headers: Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k, one(v)])),
  };
  if (input.body !== undefined) {
    out.body = typeof input.body === 'string' ? one(input.body) : mapJson(input.body, one);
  }
  const { auth } = input;
  if (auth) {
    if ('basic' in auth) {
      const username = one(auth.basic.username);
      if (username.includes(':')) {
        throw new Failure(fail('refused', 'a Basic auth username cannot contain ":"'));
      }
      out.auth = { basic: { username, password: one(auth.basic.password) } };
    } else if ('bearer' in auth) out.auth = { bearer: one(auth.bearer) };
    else if ('header' in auth)
      out.auth = { header: { name: auth.header.name, value: one(auth.header.value) } };
    else out.auth = { query: { name: auth.query.name, value: one(auth.query.value) } };
  }
  return out;
}

const fail = (kind: FetchFailure['error']['kind'], message: string): FetchFailure => ({
  ok: false,
  error: { kind, message },
});

class Failure extends Error {
  constructor(readonly failure: FetchFailure) {
    super(failure.error.message);
  }
}

const safeOrigin = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
};

export function resolveAllowedOrigins(
  declared: string[],
  settings: Record<string, JsonValue>,
): string[] {
  const origins: string[] = [];
  for (const entry of declared) {
    let candidate: string | null = null;
    if (entry.startsWith('$settings.')) {
      const value = settings[entry.slice('$settings.'.length)];
      candidate = typeof value === 'string' ? safeOrigin(value) : null;
    } else {
      candidate = safeOrigin(entry);
    }
    if (candidate && !origins.includes(candidate)) origins.push(candidate);
  }
  return origins;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

class Aborted extends Error {}

/** Rejects with Aborted as soon as the signal fires. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new Aborted());
    else signal.addEventListener('abort', () => reject(new Aborted()), { once: true });
  });
}

/** Seconds or an HTTP date, in ms, capped. `null` when absent or unreadable. */
function retryAfterMs(header: string | undefined, now: number): number | null {
  if (header === undefined) return null;
  const trimmed = header.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return null;
    ms = Math.max(0, date - now);
  }
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export class FetchProxy {
  private policy: FetchPolicy = { allowedOrigins: [], allowInsecureTls: false };
  private secrets = new Map<string, string>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private tokens: number;
  private refilledAt: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly pluginName: string,
    private readonly deps: FetchProxyDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.tokens = deps.limits.fetchPerSecond;
    this.refilledAt = this.now();
  }

  setPolicy(p: FetchPolicy): void {
    this.policy = p;
  }

  /**
   * The plugin's own decrypted secret values by field path. Throws (naming the two field paths,
   * never a value) when two paths sanitise to the same token key; the previous values stay.
   */
  setSecrets(values: Record<string, string>): void {
    this.secrets = secretMap(values);
  }

  async fetch(
    rawInput: FetchInput,
    opts: {
      override?: FetchPolicy | undefined;
      signal?: AbortSignal | undefined;
      /** Candidate values (an integration `test` call); win over `setSecrets` for this request only. */
      secrets?: Record<string, string> | undefined;
    } = {},
  ): Promise<FetchResult> {
    const { signal } = opts;
    const policy = opts.override ?? this.policy;
    // Refuse before queueing so a refused call never waits for a slot.
    const first = this.checkOrigin(rawInput.url, policy);
    if (first) return first;
    let input: FetchInput;
    try {
      let secrets = this.secrets;
      if (opts.secrets) secrets = new Map([...secrets, ...secretMap(opts.secrets)]);
      input = substituteInput(rawInput, secrets);
    } catch (err) {
      if (err instanceof Failure) return err.failure;
      return fail('refused', 'secret field names are ambiguous');
    }
    // A secret that changed the shape of the url must not have changed its origin.
    const second = this.checkOrigin(input.url, policy);
    if (second) return second;
    const { limits } = this.deps;
    const timeoutMs = Math.min(
      input.timeoutMs ?? limits.fetchDefaultTimeoutMs,
      limits.fetchMaxTimeoutMs,
    );
    // One deadline for the whole call: queue, token waits, every hop, the Retry-After sleep and the retry.
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal?.aborted) ctrl.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.run(input, policy, ctrl.signal);
    } catch (err) {
      if (err instanceof Failure) return err.failure;
      if (err instanceof Aborted || ctrl.signal.aborted) {
        return timedOut
          ? fail('timeout', `no complete response within ${timeoutMs} ms`)
          : fail('failed', 'request aborted');
      }
      return fail('failed', 'request failed');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private checkOrigin(url: string, policy: FetchPolicy): FetchFailure | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail('refused', 'url is not valid');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fail('refused', `scheme ${parsed.protocol.slice(0, -1)} is not allowed`);
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return fail('refused', 'credentials in the url are not allowed');
    }
    if (!policy.allowedOrigins.includes(parsed.origin)) {
      return fail(
        'refused',
        `origin ${parsed.origin} is not allowed for plugin ${this.pluginName}`,
      );
    }
    return null;
  }

  private acquireSlot(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Aborted());
    if (this.active < this.deps.limits.fetchConcurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= MAX_QUEUED) {
      return Promise.reject(
        new Failure(fail('rate-limited', 'too many requests are already queued')),
      );
    }
    // The releasing request hands its slot straight to the next waiter.
    return new Promise<void>((resolve, reject) => {
      const entry = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new Aborted());
      };
      this.waiting.push(entry);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private releaseSlot(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }

  private async takeToken(signal: AbortSignal): Promise<void> {
    const perSecond = this.deps.limits.fetchPerSecond;
    for (;;) {
      if (signal.aborted) throw new Aborted();
      const now = this.now();
      const elapsed = Math.max(0, now - this.refilledAt);
      this.tokens = Math.min(perSecond, this.tokens + (elapsed * perSecond) / 1000);
      this.refilledAt = Math.max(now, this.refilledAt);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await Promise.race([
        this.sleep(Math.ceil(((1 - this.tokens) * 1000) / perSecond), signal),
        untilAborted(signal),
      ]);
    }
  }

  private async attempt(
    input: FetchInput,
    policy: FetchPolicy,
    signal: AbortSignal,
  ): Promise<RawResponse> {
    await this.acquireSlot(signal);
    try {
      return await this.roundTrip(input, policy, signal);
    } finally {
      this.releaseSlot();
    }
  }

  private async run(
    input: FetchInput,
    policy: FetchPolicy,
    signal: AbortSignal,
  ): Promise<FetchResult> {
    let raw = await this.attempt(input, policy, signal);
    if (raw.status === 429) {
      const wait = retryAfterMs(raw.headers['retry-after'], this.now());
      if (wait !== null) {
        // The concurrency slot is free while we wait.
        await Promise.race([this.sleep(wait, signal), untilAborted(signal)]);
        raw = await this.attempt(input, policy, signal);
      }
      if (raw.status === 429)
        return fail('rate-limited', 'the service answered 429 Too Many Requests');
    }
    return this.finish(raw, input.accept);
  }

  private finish(raw: RawResponse, accept: FetchInput['accept']): FetchResult {
    const headers: Record<string, string> = {};
    for (const name of RETURNED_HEADERS) {
      const value = raw.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    let body: FetchOutput['body'] = null;
    if (accept === 'text') body = raw.body.toString('utf8');
    else if (accept === 'json' && raw.body.length > 0) {
      try {
        body = JSON.parse(raw.body.toString('utf8')) as JsonValue;
      } catch {
        return fail('failed', 'response is not valid JSON');
      }
    }
    return { ok: true, response: { status: raw.status, headers, body } };
  }

  /** One logical request: token, then the redirect chain. Every hop shares the call's deadline signal. */
  private async roundTrip(
    input: FetchInput,
    policy: FetchPolicy,
    signal: AbortSignal,
  ): Promise<RawResponse> {
    let url = new URL(input.url);
    let method: string = input.method;
    let body = input.body;
    const baseOrigin = url.origin;
    for (let hop = 0; ; hop += 1) {
      await this.takeToken(signal);
      const pinned = await this.pin(url, signal);
      const raw = await this.once(url, method, input, body, policy, signal, pinned);
      if (!REDIRECT_STATUSES.has(raw.status)) return raw;
      const location = raw.headers.location;
      if (!location) return raw;
      if (hop >= MAX_REDIRECTS) throw new Failure(fail('refused', 'too many redirects'));
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new Failure(fail('refused', 'redirect target is not valid'));
      }
      if (next.origin !== baseOrigin) {
        throw new Failure(fail('refused', 'redirect to another origin is not allowed'));
      }
      const denied = this.checkOrigin(next.href, policy);
      if (denied) throw new Failure(denied);
      if (
        raw.status === 303 ||
        ((raw.status === 301 || raw.status === 302) && method !== 'GET' && method !== 'HEAD')
      ) {
        method = 'GET';
        body = undefined;
      }
      url = next;
    }
  }

  /**
   * Resolves the hop's host once, checks every answer, and returns the address to connect to
   * (null for an IP literal, which Node connects to without a lookup). Loopback, link-local,
   * metadata and reserved addresses are always refused; a private address only when the
   * allow-listed origin's host is itself private. The connection then uses exactly this address,
   * so a resolver cannot answer the check with one address and the connect with another.
   */
  private async pin(url: URL, signal: AbortSignal): Promise<ResolvedAddress | null> {
    const classify = this.deps.classify ?? classifyAddress;
    const host = url.hostname;
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    const originIsPrivate = isPrivateHost(host, classify);
    const literal = isIP(bare) !== 0;
    let answers: ResolvedAddress[];
    if (literal) answers = [{ address: bare, family: isIP(bare) }];
    else {
      try {
        answers = await Promise.race([
          (this.deps.resolve ?? defaultResolve)(bare),
          untilAborted(signal),
        ]);
      } catch (err) {
        if (err instanceof Aborted) throw err;
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        throw new Failure(fail('failed', `request failed: ${code ?? 'name not resolved'}`));
      }
    }
    if (answers.length === 0) throw new Failure(fail('failed', 'request failed: ENOTFOUND'));
    for (const answer of answers) {
      const why = addressVerdict(classify(answer.address), originIsPrivate);
      if (why) throw new Failure(fail('refused', `${bare} resolves to ${why}`));
    }
    return literal ? null : (answers[0] ?? null);
  }

  private once(
    url: URL,
    method: string,
    input: FetchInput,
    body: FetchInput['body'],
    policy: FetchPolicy,
    signal: AbortSignal,
    pinned: ResolvedAddress | null,
  ): Promise<RawResponse> {
    const isHttps = url.protocol === 'https:';
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers)) {
      if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
    const target = new URL(url);
    const { auth } = input;
    if (auth) {
      const setHeader = (name: string, value: string) => {
        for (const existing of Object.keys(headers)) {
          if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
        }
        headers[name] = value;
      };
      if ('basic' in auth) {
        const pair = `${auth.basic.username}:${auth.basic.password}`;
        setHeader('Authorization', `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`);
      } else if ('bearer' in auth) setHeader('Authorization', `Bearer ${auth.bearer}`);
      else if ('header' in auth) setHeader(auth.header.name, auth.header.value);
      else {
        const extra = new URLSearchParams([[auth.query.name, auth.query.value]]).toString();
        target.search = target.search ? `${target.search.slice(1)}&${extra}` : extra;
      }
    }
    let payload: Buffer | undefined;
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      if (typeof body === 'string') payload = Buffer.from(body, 'utf8');
      else {
        payload = Buffer.from(JSON.stringify(body), 'utf8');
        if (!Object.keys(headers).some((n) => n.toLowerCase() === 'content-type')) {
          headers['content-type'] = 'application/json';
        }
      }
      headers['content-length'] = String(payload.length);
    }
    const options: RequestOptions & { rejectUnauthorized?: boolean } = {
      method,
      headers,
      agent: false,
    };
    if (isHttps && policy.allowInsecureTls) options.rejectUnauthorized = false;
    if (pinned) {
      // The url keeps the name, so Host and TLS SNI/verification stay on it; only the socket's
      // lookup is answered with the address `pin` checked.
      const lookup = (
        _hostname: string,
        lookupOptions: { all?: boolean },
        callback: (...args: unknown[]) => void,
      ) => {
        if (lookupOptions.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      };
      options.lookup = lookup as unknown as LookupFunction;
    }
    const send = isHttps
      ? (this.deps.request ?? httpsRequest)
      : (this.deps.requestHttp ?? httpRequest);
    const cap = this.deps.limits.fetchBodyBytes;
    const drainOnly = input.accept === 'none';

    return new Promise<RawResponse>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Aborted());
        return;
      }
      let settled = false;
      let req: ReturnType<typeof send> | undefined;
      const onAbort = () => {
        req?.destroy();
        done(() => reject(new Aborted()));
      };
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        fn();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        req = send(target, options, (res: IncomingMessage) => {
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > cap) {
            req?.destroy();
            done(() => reject(new Failure(fail('failed', 'response larger than 16 MB'))));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > cap) {
              req?.destroy();
              done(() => reject(new Failure(fail('failed', 'response larger than 16 MB'))));
              return;
            }
            if (!drainOnly) chunks.push(chunk);
          });
          res.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(res.headers)) {
              if (value !== undefined)
                headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
            }
            done(() =>
              resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) }),
            );
          });
          res.on('error', () =>
            done(() => reject(new Failure(fail('failed', 'response interrupted')))),
          );
        });
      } catch {
        done(() => reject(new Failure(fail('failed', 'request failed'))));
        return;
      }
      req.on('error', (err: NodeJS.ErrnoException) => {
        done(() =>
          reject(new Failure(fail('failed', `request failed: ${err.code ?? 'network error'}`))),
        );
      });
      req.end(payload);
    });
  }
}
