import type { Migration } from '../migrate.ts';

export const workflows: Migration = {
  version: 2,
  name: '0002_workflows',
  up(db) {
    db.exec(`
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('workflow','subworkflow')),
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry-run','enabled')),
  current_version INTEGER NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  review_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX workflows_deleted_at ON workflows(deleted_at);

CREATE TABLE workflow_versions (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  graph TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, version)
);
`);
  },
};
