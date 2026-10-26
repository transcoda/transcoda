import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as inspector from 'node:inspector';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { defineIntegration, defineNode, definePlugin } from '@transcoda/sdk';
import { z } from 'zod';

// Captured at module top level, i.e. before the host's setup: must already be the replaced fetch.
const capturedFetch = globalThis.fetch;

type Report = Record<string, string>;
let report: Report = {};

/** The error code, else its name; 'OK' when the probe did not throw. */
async function probe(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return 'OK';
  } catch (e) {
    const err = e as { code?: unknown; name?: unknown };
    return String(err.code ?? err.name);
  }
}

async function runProbes(otherBundle: string): Promise<Report> {
  const bundle = process.argv[2] ?? '';
  const out: Report = {};
  out.writeOwnDir = await probe(() => fs.writeFileSync(join(dirname(bundle), 'denial-probe'), 'x'));
  out.writeTmp = await probe(() => fs.writeFileSync(join(tmpdir(), 'denial-probe'), 'x'));
  out.readOtherBundle = await probe(() => fs.readFileSync(otherBundle));
  out.readEtcPasswd = await probe(() => fs.readFileSync('/etc/passwd'));
  out.readdirOwnDir = await probe(() => fs.readdirSync(dirname(bundle)));
  out.readOwnBundleAfterDrop = await probe(() => fs.readFileSync(bundle));
  out.spawn = await probe(() => execFileSync('true'));
  out.worker = await probe(() => new Worker(new URL('data:text/javascript,')));
  out.addon = await probe(() => process.dlopen({ exports: {} }, '/nonexistent.node'));
  out.wasi = await probe(async () => {
    const { WASI } = await import('node:wasi');
    return new WASI({ version: 'preview1' });
  });
  out.inspector = await probe(() => inspector.open(0));
  // __CF_USER_TEXT_ENCODING is added to every child by macOS itself.
  out.envKeys = Object.keys(process.env)
    .filter((k) => k !== '__CF_USER_TEXT_ENCODING')
    .sort()
    .join(',');
  // Never fd 3: with an 'ipc' stdio entry fd 3 is the IPC socket and reading it eats messages.
  out.fd4 = await probe(() => fs.readSync(4, Buffer.alloc(1)));
  try {
    await globalThis.fetch('http://127.0.0.1:1/');
    out.globalFetch = 'OK';
  } catch (e) {
    out.globalFetch = (e as Error).message;
  }
  try {
    await capturedFetch('http://127.0.0.1:1/');
    out.topLevelFetch = 'OK';
  } catch (e) {
    out.topLevelFetch = (e as Error).message;
  }
  // biome-ignore lint/security/noGlobalEval: the probe checks that eval of a string is refused
  out.evalString = await probe(() => eval('1'));
  out.processBinding = await probe(() =>
    (process as unknown as { binding(name: string): unknown }).binding('fs'),
  );
  // Same uid as the server: signal 0 succeeds. Isolated: the host has no capabilities, EPERM.
  out.signalServer = await probe(() => process.kill(process.ppid, 0));
  out.uid = String(process.getuid?.() ?? 'n/a');
  return out;
}

const integration = defineIntegration({
  id: 'denial',
  title: 'Denial probes',
  settings: z.object({ otherBundle: z.string().default('') }),
  allowedOrigins: [],
  async test() {
    return { ok: true, message: 'probes ran in setup' };
  },
});

const reportNode = defineNode({
  type: 'denial:report',
  version: 1,
  kind: 'data',
  title: 'Denial report',
  description: 'Returns the sandbox probe results.',
  icon: 'shield',
  inputs: [],
  outputs: [{ id: 'value', label: 'Report', type: 'data:report' }],
  settings: z.object({}),
  async data() {
    return { value: report, reason: 'probe report' };
  },
});

export default definePlugin({
  name: 'denial',
  version: '0.1.0',
  sdk: '^1',
  integration,
  nodes: [reportNode],
  async setup(ctx) {
    const other = ctx.settings.otherBundle;
    report = await runProbes(typeof other === 'string' ? other : '');
  },
});
