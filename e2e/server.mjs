// Starts the built server for the Playwright tests: a fresh config folder, the media from
// `pnpm fixtures` laid out as a small movie library, and nothing that reaches the network.
// Usage: node e2e/server.mjs (Playwright's webServer runs it; `pnpm build` and `pnpm fixtures` first).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURES = join(ROOT, '.local', 'fixtures');
/** A fixed path, so pages that show a library's folder look the same on every machine. */
export const WORK = process.env.E2E_WORK ?? '/tmp/transcoda-e2e';
export const PORT = Number(process.env.E2E_PORT ?? 4173);

/** Invented titles only: each fixture becomes one movie in its own folder. */
const MOVIES = [
  ['otter-finch.mp4', 'Otter and Finch (2021)'],
  ['h264-big.mkv', 'Harbor Lights (1931)'],
  ['two-defaults.mkv', 'The Paper Lantern (1928)'],
  ['compliant.mkv', 'Quiet Meadow (1934)'],
];

for (const need of [join(FIXTURES, 'manifest.json'), join(ROOT, 'apps/server/dist/main.js')]) {
  if (!existsSync(need)) {
    console.error(`missing ${need}: run \`pnpm fixtures\` and \`pnpm build\` first`);
    process.exit(1);
  }
}

await rm(WORK, { recursive: true, force: true });
const dirs = ['config', 'transcode', 'run', 'media/movies'].map((d) => join(WORK, d));
for (const d of dirs) await mkdir(d, { recursive: true });

// Backdated an hour, so the library's settle window never treats them as still being written.
const past = new Date(Date.now() - 60 * 60 * 1000);
for (const [fixture, title] of MOVIES) {
  const folder = join(WORK, 'media/movies', title);
  await mkdir(folder);
  const dest = join(folder, `${title}${fixture.slice(fixture.lastIndexOf('.'))}`);
  await copyFile(join(FIXTURES, fixture), dest);
  await utimes(dest, past, past);
}

const server = spawn(process.execPath, ['dist/main.js'], {
  cwd: join(ROOT, 'apps/server'),
  stdio: 'inherit',
  env: {
    ...process.env,
    TRANSCODA_PORT: String(PORT),
    TRANSCODA_CONFIG_DIR: join(WORK, 'config'),
    TRANSCODA_TRANSCODE_DIR: join(WORK, 'transcode'),
    TRANSCODA_PLUGIN_RUN_DIR: join(WORK, 'run'),
    TRANSCODA_WEB_DIR: join(ROOT, 'apps/web/dist'),
    TRANSCODA_UPDATE_CHECK: 'false',
    TRANSCODA_PLUGIN_CATALOG_KEY: 'none',
    TRANSCODA_PLUGIN_CATALOG_URL: `http://127.0.0.1:${PORT}/no-catalog`,
    TRANSCODA_PLUGIN_BLOCKLIST_URL: `http://127.0.0.1:${PORT}/no-blocklist`,
  },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));
server.on('exit', (code) => process.exit(code ?? 0));
