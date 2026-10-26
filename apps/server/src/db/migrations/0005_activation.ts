import type { Migration } from '../migrate.ts';

/**
 * One nullable pointer per workflow replaces `mode`, `needs_review` and `review_note`. Frozen SQL:
 * every name is spelled literally. Rebuilds `workflows` (SQLite cannot drop a CHECKed column in
 * place), so it runs with foreign keys off: with them on, DROP TABLE would cascade-delete every
 * workflow_versions row and fail on the libraries/runs references.
 */
export const activation: Migration = {
  version: 5,
  name: '0005_activation',
  foreignKeys: 'off',
  up(db) {
    db.exec(`
CREATE TABLE workflows_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('workflow','subworkflow')),
  name TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  active_version INTEGER,
  activated_at TEXT,
  activated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (kind = 'workflow' OR active_version IS NULL),
  CHECK ((active_version IS NULL) = (activated_at IS NULL) AND (active_version IS NULL) = (activated_by IS NULL)),
  FOREIGN KEY (id, active_version) REFERENCES workflow_versions(workflow_id, version)
);

INSERT INTO workflows_new
SELECT w.id, w.kind, w.name, w.current_version,
       CASE WHEN w.ok THEN w.current_version END,
       CASE WHEN w.ok THEN w.updated_at END,
       CASE WHEN w.ok THEN 'system:migration' END,
       w.created_at, w.updated_at, w.deleted_at
FROM (
  SELECT w.*, (w.kind = 'workflow' AND w.mode = 'enabled' AND w.needs_review = 0
               AND EXISTS (SELECT 1 FROM workflow_versions v
                           WHERE v.workflow_id = w.id AND v.version = w.current_version)) AS ok
  FROM workflows w
) w;

DROP TABLE workflows;
ALTER TABLE workflows_new RENAME TO workflows;
CREATE INDEX workflows_deleted_at ON workflows(deleted_at);

ALTER TABLE runs ADD COLUMN note TEXT;

DELETE FROM settings WHERE key = 'workflow_review_acks';
`);
  },
};
