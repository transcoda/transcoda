import type { Migration } from '../migrate.ts';

/**
 * The warnings and problems of a result that belong to one node (`NodeProblem`), so the job page
 * can badge that node. Purely additive; older results read `[]` (no badge).
 */
export const nodeProblems: Migration = {
  version: 21,
  name: '0021_node_problems',
  up(db) {
    db.exec("ALTER TABLE job_results ADD COLUMN node_problems_json TEXT NOT NULL DEFAULT '[]';");
  },
};
