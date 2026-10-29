import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { type LicencesOutput, ThirdPartyFileSchema } from '@transcoda/contract';
import { DEVICE_PROFILE_IDS, DEVICE_PROFILES } from '@transcoda/shared';
import {
  backupDatabase,
  backupDirOf,
  describeBackups,
  KEEP_BACKUPS,
  pruneBackups,
} from '../../db/backup.ts';
import { schemaVersion } from '../../db/migrate.ts';
import type { AppDeps } from '../context.ts';
import { os, requireHumanSessionWith, requireScope } from '../middleware.ts';

const deviceProfiles = DEVICE_PROFILE_IDS.map((id) => ({ id, name: DEVICE_PROFILES[id].name }));

export const health = os.system.health.handler(async ({ input, context, errors }) => {
  const version = context.deps.version;
  if (input?.deep === undefined) return { status: 'ok' as const, version };
  const checks = await context.deps.health.deep();
  if (Object.values(checks).some((c) => c === 'fail')) {
    throw errors.UNHEALTHY({ data: { status: 'fail', version, checks } });
  }
  return { status: 'ok' as const, version, checks };
});

export const capabilities = os.system.capabilities
  .use(requireScope('read'))
  .handler(({ context }) => ({ ...context.deps.capabilities(), deviceProfiles }));

export const gpuLoad = os.system.gpuLoad
  .use(requireScope('read'))
  .handler(({ context }) => context.deps.gpuLoad.snapshot());

export const update = os.system.update
  .use(requireScope('read'))
  .handler(({ context }) => context.deps.appUpdate.status());

// Parsed once per app: the file is part of the build. A missing or unreadable file is not
// remembered, so `pnpm licences` during development is picked up without a restart.
const licenceCache = new WeakMap<AppDeps, LicencesOutput>();

async function loadLicences(deps: AppDeps): Promise<LicencesOutput> {
  const cached = licenceCache.get(deps);
  if (cached) return cached;
  let raw: string;
  try {
    raw = await readFile(deps.thirdPartyFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { available: false };
    throw err;
  }
  let result: LicencesOutput;
  try {
    result = { ...ThirdPartyFileSchema.parse(JSON.parse(raw)), available: true };
  } catch {
    deps.log.warn({
      msg: 'third-party list is unreadable; licences are not shown',
      file: 'third-party.json',
    });
    return { available: false };
  }
  licenceCache.set(deps, result);
  return result;
}

export const licences = os.system.licences
  .use(requireScope('read'))
  .handler(({ context }) => loadLicences(context.deps));

export const backupsList = os.system.backups.list
  .use(requireScope('read'))
  .handler(({ context }) => ({
    backups: describeBackups(backupDirOf(context.deps.config.configDir)),
    keep: KEEP_BACKUPS,
  }));

/** "Back up now" at most once per this many ms (a double click or a script loop fills the disk). */
const MANUAL_BACKUP_INTERVAL_MS = 30_000;
const lastManualBackup = new WeakMap<AppDeps, number>();

// Taking a backup is a person's job, like changing a setting: never an API token, never MCP.
export const backupsCreate = os.system.backups.create
  .use(requireHumanSessionWith('Backups are taken in the UI'))
  .handler(({ context, errors }) => {
    const { db, config, now, log } = context.deps;
    const at = now();
    const last = lastManualBackup.get(context.deps);
    if (last !== undefined && at.getTime() - last < MANUAL_BACKUP_INTERVAL_MS) {
      const wait = Math.ceil((last + MANUAL_BACKUP_INTERVAL_MS - at.getTime()) / 1000);
      throw errors.RATE_LIMITED({
        message: `A backup was taken moments ago; try again in ${wait} s`,
        data: { retryAfterSeconds: wait },
      });
    }
    const dir = backupDirOf(config.configDir);
    const file = backupDatabase(db, dir, at, schemaVersion(db), 'manual');
    lastManualBackup.set(context.deps, at.getTime());
    pruneBackups(dir, KEEP_BACKUPS);
    log.info(`Backed up database to ${file} (Back up now)`);
    const name = basename(file);
    const entry = describeBackups(dir).find((b) => b.name === name);
    if (!entry) throw new Error('backup vanished right after it was written');
    return entry;
  });
