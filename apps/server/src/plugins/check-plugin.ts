// `transcoda --check-plugin <bundle>`: starts one sandboxed host over a bundle with empty settings,
// reports what the bundle says about itself, then stops. Used by the plugins repo's host-check
// script, dev mode (to read a dev bundle's manifest) and the image's sandbox job.
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_VERSION } from '@transcoda/sdk';
import {
  DEFAULT_LIMITS,
  type JsonValue,
  type PluginManifest,
  type SupervisorLimits,
} from '@transcoda/shared';
import semver from 'semver';
import { type PluginIsolation, parseIsolation } from '../config.ts';
import { processIdentity } from './isolation.ts';
import {
  defaultRssOf,
  describeExit,
  forkHost,
  PluginProcess,
  PluginStartError,
} from './process.ts';
import { SANDBOX_EXPECTATIONS, sandboxExpectations } from './sandbox-expectations.ts';

/** Probes the denial fixture reports; `--expect-denials` checks every one. */
export const DENIAL_PROBES = Object.keys(SANDBOX_EXPECTATIONS).length;

export type CheckResult =
  | {
      ok: true;
      name: string;
      version: string;
      sdk: string;
      /** Whether this server's SDK satisfies the bundle's `sdk` range (prereleases count). */
      compatible: boolean;
      nodes: string[];
      integration: string | null;
      triggers: string[];
      /** Job hooks the bundle declares. */
      hooks: PluginManifest['hooks'];
      probes?: number;
      /** What the OS says the host process was while it ran (Linux only); null when unknown. */
      isolation: {
        uid: number;
        gid: number;
        capEff: string;
        capPrm: string;
        capAmb: string;
        noNewPrivs: number;
      } | null;
    }
  | {
      ok: false;
      error: string;
      failures?: Array<{ probe: string; expected: string; got: string }>;
    };

export interface CheckOptions {
  /** Calls the bundle's `denial:report` data node and compares it with SANDBOX_EXPECTATIONS. */
  expectDenials?: boolean | undefined;
  /** Handed to the denial fixture as its `otherBundle` setting; defaults to the bundle itself. */
  otherBundle?: string | undefined;
}

export interface CheckDeps {
  hostPath: string;
  limits?: SupervisorLimits | undefined;
  /** The SDK version to judge `compatible` against (default SDK_VERSION). */
  sdkVersion?: string | undefined;
  /** Start the host as this user through setpriv (`runCheckPlugin` reads it from the environment). */
  isolation?: PluginIsolation | null | undefined;
}

const ZERO_CAPS = '0000000000000000';

/** What a hook context needs for a data node that ignores it: one stream, an empty file. */
const PROBE_CONTEXT: JsonValue = {
  probe: {
    container: 'matroska',
    durationSeconds: 1,
    sizeBytes: 0,
    bitrateKbps: null,
    streams: [{ index: 0, type: 'video', codec: 'h264', language: null }],
    formatName: 'matroska,webm',
    chapters: 0,
    raw: {},
  },
  file: { path: '/dev/null', sizeBytes: 0, mtime: '1970-01-01T00:00:00.000Z', nlink: 1 },
  data: {},
  capabilities: { encoders: [], filters: [], hwaccels: [] },
};

const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One host start over `bundlePath`; the process is always gone when this returns. */
export async function checkPluginBundle(
  bundlePath: string,
  deps: CheckDeps,
  opts: CheckOptions = {},
): Promise<CheckResult> {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  // A symlinked path would hand the sandbox a grant for the link, not the file.
  let bundle: string;
  try {
    bundle = await realpath(bundlePath);
  } catch (e) {
    return { ok: false, error: `cannot read ${bundlePath}: ${text(e)}` };
  }
  const other = opts.otherBundle === undefined ? bundle : resolve(opts.otherBundle);
  const proc = new PluginProcess('check', bundle, deps.hostPath, {
    fork: forkHost,
    rssOf: defaultRssOf,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    limits,
    isolation: deps.isolation ?? null,
    fetch: async () => ({
      ok: false,
      error: { kind: 'refused', message: 'no network while checking a plugin' },
    }),
    onLog: () => {},
  });
  try {
    let ready: Awaited<ReturnType<PluginProcess['start']>>;
    try {
      ready = await proc.start({
        settings: opts.expectDenials === true ? { otherBundle: other } : {},
        manifest: null,
        sha256: '',
      });
    } catch (e) {
      return {
        ok: false,
        error: e instanceof PluginStartError ? describeStart(e) : text(e),
      };
    }
    const m: PluginManifest = ready.manifest;
    const result: Extract<CheckResult, { ok: true }> = {
      ok: true,
      name: m.name,
      version: m.version,
      sdk: m.sdk,
      compatible: semver.satisfies(deps.sdkVersion ?? SDK_VERSION, m.sdk, {
        includePrerelease: true,
      }),
      nodes: m.nodes,
      integration: m.integration,
      triggers: m.triggers,
      hooks: m.hooks,
      // Taken while the host is up.
      isolation: await processIdentity(proc.pid),
    };
    if (opts.expectDenials !== true) return result;
    const answer = await proc.call(
      {
        type: 'call',
        hook: 'data',
        nodeType: 'denial:report',
        nodeVersion: 1,
        ctx: PROBE_CONTEXT,
        settings: {},
      },
      limits.callTimeoutMs,
    );
    if (!answer.ok) return { ok: false, error: `denial report failed: ${answer.error.message}` };
    const report = (answer.result as { value?: Record<string, string> } | null)?.value;
    if (report === undefined || report === null || typeof report !== 'object') {
      return { ok: false, error: 'denial report has no value' };
    }
    const failures: Array<{ probe: string; expected: string; got: string }> = [];
    const iso = deps.isolation ?? null;
    const table =
      iso === null
        ? SANDBOX_EXPECTATIONS
        : sandboxExpectations({ isolatedUid: iso.uid, ownUid: process.getuid?.() ?? null });
    if (iso !== null) failures.push(...identityFailures(iso, result.isolation));
    for (const [probe, expected] of Object.entries(table)) {
      const got = report[probe] ?? '(missing)';
      const good = typeof expected === 'string' ? got === expected : expected.test(got);
      if (!good) failures.push({ probe, expected: String(expected), got });
    }
    for (const probe of Object.keys(report)) {
      if (!(probe in table)) {
        failures.push({ probe, expected: '(not a known probe)', got: String(report[probe]) });
      }
    }
    if (failures.length > 0) {
      return { ok: false, error: `${failures.length} sandbox probes differ`, failures };
    }
    return { ...result, probes: Object.keys(report).length };
  } catch (e) {
    return { ok: false, error: text(e) };
  } finally {
    await proc.stop();
  }
}

/**
 * What the OS says about the host must match the isolation that was asked for. CapBnd is not
 * checked: dropping it needs CAP_SETPCAP, and with nothing permitted it cannot be exercised.
 */
function identityFailures(
  iso: PluginIsolation,
  got: Extract<CheckResult, { ok: true }>['isolation'],
): Array<{ probe: string; expected: string; got: string }> {
  const out: Array<{ probe: string; expected: string; got: string }> = [];
  const note = (probe: string, expected: string | number, actual: string | number | undefined) => {
    if (String(expected) !== String(actual)) {
      out.push({ probe, expected: String(expected), got: String(actual ?? '(unknown)') });
    }
  };
  note('identity.uid', iso.uid, got?.uid);
  note('identity.gid', iso.gid, got?.gid);
  note('identity.capEff', ZERO_CAPS, got?.capEff);
  note('identity.capPrm', ZERO_CAPS, got?.capPrm);
  note('identity.capAmb', ZERO_CAPS, got?.capAmb);
  note('identity.noNewPrivs', 1, got?.noNewPrivs);
  return out;
}

/** `crashed: bundle has no plugin default export` reads better as the bare reason. */
function describeStart(e: PluginStartError): string {
  return e.reason.kind === 'uncaught' ? e.reason.message : describeExit(e.reason);
}

export interface ParsedCheckArgs {
  bundle: string;
  expectDenials: boolean;
  otherBundle?: string;
}

/** `--check-plugin <file> [--expect-denials] [--other-bundle <file>]`; throws a usage message. */
export function parseCheckArgs(argv: string[]): ParsedCheckArgs {
  const at = argv.indexOf('--check-plugin');
  const bundle = argv[at + 1];
  if (at < 0 || bundle === undefined || bundle.startsWith('--')) {
    throw new Error('usage: --check-plugin <bundle.js> [--expect-denials] [--other-bundle <file>]');
  }
  const out: ParsedCheckArgs = { bundle, expectDenials: false };
  const rest = argv.slice(at + 2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--expect-denials') out.expectDenials = true;
    else if (arg === '--other-bundle') {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--'))
        throw new Error('--other-bundle needs a file');
      out.otherBundle = value;
    } else throw new Error(`unknown argument ${arg ?? ''}`);
  }
  return out;
}

/** The host the one-shot needs: TRANSCODA_PLUGIN_HOST, else `plugin-host.js` beside the running entry. */
export function checkHostPath(env: NodeJS.ProcessEnv): string {
  const configured = env.TRANSCODA_PLUGIN_HOST;
  if (configured) return configured;
  return fileURLToPath(new URL('./plugin-host.js', import.meta.url));
}

/**
 * The CLI branch of main.ts. Touches no database, no ffmpeg and no config directory; prints one JSON
 * line and returns the exit code (0 only for `ok: true`).
 */
export async function runCheckPlugin(
  argv: string[],
  env: NodeJS.ProcessEnv,
  print: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  let result: CheckResult;
  try {
    const args = parseCheckArgs(argv);
    const hostPath = checkHostPath(env);
    if (!isAbsolute(hostPath)) throw new Error('TRANSCODA_PLUGIN_HOST must be an absolute path');
    result = await checkPluginBundle(
      resolve(args.bundle),
      { hostPath, isolation: parseIsolation(env, process.platform, process.getuid?.() ?? null) },
      { expectDenials: args.expectDenials, otherBundle: args.otherBundle },
    );
  } catch (e) {
    result = { ok: false, error: text(e) };
  }
  print(JSON.stringify(result));
  return result.ok ? 0 : 1;
}
