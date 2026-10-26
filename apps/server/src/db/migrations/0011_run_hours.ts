import type { Migration } from '../migrate.ts';

/**
 * Run hours: a library's window for automatic jobs (JSON, NULL = no restriction, so every existing
 * library behaves as before) and where a run came from (`library`: its library's feeder chose the
 * workflow, so the window applies; `manual` on every existing row). Purely additive.
 */
export const runHours: Migration = {
  version: 11,
  name: '0011_run_hours',
  up(db) {
    db.exec(`
ALTER TABLE libraries ADD COLUMN run_hours TEXT;
ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'library'));
`);
  },
};
