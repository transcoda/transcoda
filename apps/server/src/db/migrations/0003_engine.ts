import type { Migration } from '../migrate.ts';

/** Frozen copy of JOB_STATES at this migration (a later state needs a new migration). */
const STATES = [
  'queued',
  'probing',
  'deciding',
  'building',
  'encoding',
  'verifying',
  'replacing',
  'done',
  'nothing_to_do',
  'kept_original',
  'failed',
  'cancelled',
  'dry_run',
  'skipped',
  'already_processed',
];
const states = STATES.map((s) => `'${s}'`).join(',');
/** done … already_processed */
const finalStates = STATES.slice(7)
  .map((s) => `'${s}'`)
  .join(',');
const flag = (column: string): string => `${column} IN (0, 1)`;

export const engine: Migration = {
  version: 3,
  name: '0003_engine',
  up(db) {
    db.exec(`
CREATE TABLE libraries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  recycle_folder TEXT,
  process_hardlinked INTEGER NOT NULL DEFAULT 0 CHECK (${flag('process_hardlinked')}),
  verify_full_decode INTEGER NOT NULL DEFAULT 0 CHECK (${flag('verify_full_decode')}),
  default_workflow_id TEXT REFERENCES workflows(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX libraries_live_path ON libraries(path) WHERE deleted_at IS NULL;

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id),
  path TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  ino INTEGER NOT NULL,
  dev INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  last_probe TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX files_library_id ON files(library_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  workflow_version INTEGER NOT NULL,
  requested_path TEXT NOT NULL,
  dry_run INTEGER NOT NULL CHECK (${flag('dry_run')}),
  force INTEGER NOT NULL CHECK (${flag('force')}),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  library_id TEXT NOT NULL,
  file_id TEXT REFERENCES files(id),
  path TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  dry_run INTEGER NOT NULL CHECK (${flag('dry_run')}),
  state TEXT NOT NULL CHECK (state IN (${states})),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (${flag('paused')}),
  priority INTEGER NOT NULL DEFAULT 0,
  lane TEXT CHECK (lane IN ('encode','quick')),
  attempt INTEGER NOT NULL DEFAULT 1,
  requeues INTEGER NOT NULL DEFAULT 0,
  progress TEXT,
  reason TEXT,
  replace_journal TEXT,
  walk_path TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (state NOT IN (${finalStates}) OR finished_at IS NOT NULL)
);
CREATE INDEX jobs_run_id ON jobs(run_id);
CREATE INDEX jobs_library_id ON jobs(library_id);
CREATE INDEX jobs_state_priority ON jobs(state, priority DESC, queued_at);
CREATE INDEX jobs_finished_at ON jobs(finished_at);

CREATE TABLE job_results (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  fingerprint TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (${states})),
  before_bytes INTEGER,
  after_bytes INTEGER,
  estimated_bytes INTEGER,
  command TEXT,
  plan TEXT,
  replaced_to TEXT CHECK (replaced_to IN ('recycle','deleted')),
  log_path TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX job_results_lookup ON job_results(fingerprint, workflow_id, workflow_version);
CREATE INDEX job_results_ratios ON job_results(workflow_id, outcome, created_at);
CREATE INDEX job_results_created_at ON job_results(created_at);

CREATE TABLE job_trace (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  entry TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE recycled (
  path TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  recycled_at TEXT NOT NULL
);
`);
  },
};
