import {
  LIBRARY_INPUT_TYPE,
  libraryInputOf,
  type WorkflowGraph,
  WorkflowGraphSchema,
  type WorkflowKind,
} from '@transcoda/shared';
import type { Database } from '../open.ts';

export interface WorkflowRow {
  id: string;
  kind: WorkflowKind;
  name: string;
  currentVersion: number;
  /** The version real runs use; null when the workflow is not active. */
  activeVersion: number | null;
  activatedAt: string | null;
  activatedBy: string | null;
  /**
   * The library this workflow's active Library input takes files from (one live workflow per
   * library). Written only by migration 0008, setActiveVersion and clearActiveVersion.
   */
  activeLibraryId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface WorkflowVersionRow {
  workflowId: string;
  version: number;
  graph: WorkflowGraph;
  formatVersion: number;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export type VersionInfo = Omit<WorkflowVersionRow, 'graph' | 'formatVersion'>;

/**
 * A stored version whose JSON did not parse against WorkflowGraphSchema (never thrown while
 * reading; callers decide). `raw` is the stored text, null when the version row is missing.
 */
export type StoredVersion =
  | { ok: true; row: WorkflowVersionRow }
  | { ok: false; workflowId: string; version: number; error: string; raw: string | null };

export class VersionConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super(`Version conflict: the workflow is at version ${currentVersion}`);
    this.name = 'VersionConflictError';
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

interface DbWorkflow {
  id: string;
  kind: WorkflowKind;
  name: string;
  current_version: number;
  active_version: number | null;
  activated_at: string | null;
  activated_by: string | null;
  active_library_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface DbVersion {
  workflow_id: string;
  version: number;
  graph: string;
  format_version: number;
  note: string | null;
  created_by: string;
  created_at: string;
}

const toWorkflow = (r: DbWorkflow): WorkflowRow => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  currentVersion: r.current_version,
  activeVersion: r.active_version,
  activatedAt: r.activated_at,
  activatedBy: r.activated_by,
  activeLibraryId: r.active_library_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

function toStoredVersion(r: DbVersion): StoredVersion {
  let json: unknown;
  try {
    json = JSON.parse(r.graph);
  } catch (e) {
    return {
      ok: false,
      workflowId: r.workflow_id,
      version: r.version,
      error: `Stored graph is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      raw: r.graph,
    };
  }
  const parsed = WorkflowGraphSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      workflowId: r.workflow_id,
      version: r.version,
      error: parsed.error.message,
      raw: r.graph,
    };
  }
  return {
    ok: true,
    row: {
      workflowId: r.workflow_id,
      version: r.version,
      graph: parsed.data,
      formatVersion: r.format_version,
      note: r.note,
      createdBy: r.created_by,
      createdAt: r.created_at,
    },
  };
}

function insertVersionRow(
  db: Database,
  v: {
    workflowId: string;
    version: number;
    graph: WorkflowGraph;
    note: string | null;
    createdBy: string;
    createdAt: string;
  },
): WorkflowVersionRow {
  db.prepare(
    `INSERT INTO workflow_versions (workflow_id, version, graph, format_version, note, created_by, created_at)
     VALUES (@workflow_id, @version, @graph, @format_version, @note, @created_by, @created_at)`,
  ).run({
    workflow_id: v.workflowId,
    version: v.version,
    graph: JSON.stringify(v.graph),
    format_version: v.graph.formatVersion,
    note: v.note,
    created_by: v.createdBy,
    created_at: v.createdAt,
  });
  return {
    workflowId: v.workflowId,
    version: v.version,
    graph: v.graph,
    formatVersion: v.graph.formatVersion,
    note: v.note,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
  };
}

export function insertWorkflow(
  db: Database,
  input: {
    id: string;
    kind: WorkflowKind;
    name: string;
    graph: WorkflowGraph;
    createdBy: string;
    note?: string | null;
  },
  now: Date,
): WorkflowRow {
  const ts = now.toISOString();
  const row: DbWorkflow = {
    id: input.id,
    kind: input.kind,
    name: input.name,
    current_version: 1,
    active_version: null,
    activated_at: null,
    activated_by: null,
    active_library_id: null,
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO workflows (id, kind, name, current_version, active_version, activated_at, activated_by, created_at, updated_at, deleted_at)
       VALUES (@id, @kind, @name, @current_version, @active_version, @activated_at, @activated_by, @created_at, @updated_at, @deleted_at)`,
    ).run(row);
    insertVersionRow(db, {
      workflowId: input.id,
      version: 1,
      graph: input.graph,
      note: input.note ?? null,
      createdBy: input.createdBy,
      createdAt: ts,
    });
  })();
  return toWorkflow(row);
}

export function findWorkflow(
  db: Database,
  id: string,
  opts?: { includeDeleted?: boolean },
): WorkflowRow | null {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as DbWorkflow | undefined;
  if (!row || (row.deleted_at !== null && !opts?.includeDeleted)) return null;
  return toWorkflow(row);
}

export function listWorkflows(db: Database): WorkflowRow[] {
  const rows = db
    .prepare('SELECT * FROM workflows WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, id')
    .all() as DbWorkflow[];
  return rows.map(toWorkflow);
}

export function findVersion(db: Database, id: string, version: number): StoredVersion | null {
  const row = db
    .prepare('SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?')
    .get(id, version) as DbVersion | undefined;
  return row ? toStoredVersion(row) : null;
}

/**
 * Every live workflow with its current version and, when it is active at a different version, that
 * version's stored row (`active`; null when not active or the same version). A missing version row
 * is reported as an unreadable version (`raw: null`), so no live workflow is left out.
 */
export function listCurrentVersions(
  db: Database,
): Array<{ workflow: WorkflowRow; version: StoredVersion; active: StoredVersion | null }> {
  const rows = db
    .prepare(
      `SELECT w.id AS w_id, w.kind AS w_kind, w.name AS w_name,
              w.current_version AS w_current_version, w.active_version AS w_active_version,
              w.activated_at AS w_activated_at, w.activated_by AS w_activated_by,
              w.active_library_id AS w_active_library_id,
              w.created_at AS w_created_at, w.updated_at AS w_updated_at,
              w.deleted_at AS w_deleted_at,
              v.workflow_id, v.version, v.graph, v.format_version, v.note, v.created_by, v.created_at,
              a.workflow_id AS a_workflow_id, a.version AS a_version, a.graph AS a_graph,
              a.format_version AS a_format_version, a.note AS a_note,
              a.created_by AS a_created_by, a.created_at AS a_created_at
       FROM workflows w
       LEFT JOIN workflow_versions v ON v.workflow_id = w.id AND v.version = w.current_version
       LEFT JOIN workflow_versions a ON a.workflow_id = w.id AND a.version = w.active_version
         AND w.active_version <> w.current_version
       WHERE w.deleted_at IS NULL
       ORDER BY w.name COLLATE NOCASE, w.id`,
    )
    .all() as Array<Partial<DbVersion> & Record<string, unknown>>;
  return rows.map((r) => ({
    workflow: toWorkflow({
      id: r.w_id,
      kind: r.w_kind,
      name: r.w_name,
      current_version: r.w_current_version,
      active_version: r.w_active_version,
      activated_at: r.w_activated_at,
      activated_by: r.w_activated_by,
      active_library_id: r.w_active_library_id,
      created_at: r.w_created_at,
      updated_at: r.w_updated_at,
      deleted_at: r.w_deleted_at,
    } as DbWorkflow),
    version:
      r.workflow_id == null
        ? {
            ok: false,
            workflowId: r.w_id as string,
            version: r.w_current_version as number,
            error: `Stored version ${r.w_current_version} is missing`,
            raw: null,
          }
        : toStoredVersion(r as DbVersion),
    // The composite foreign key guarantees the active row exists when the versions differ.
    active:
      r.a_workflow_id == null
        ? null
        : toStoredVersion({
            workflow_id: r.a_workflow_id,
            version: r.a_version,
            graph: r.a_graph,
            format_version: r.a_format_version,
            note: r.a_note,
            created_by: r.a_created_by,
            created_at: r.a_created_at,
          } as DbVersion),
  }));
}

export function listVersions(db: Database, id: string): VersionInfo[] {
  const rows = db
    .prepare(
      `SELECT workflow_id, version, note, created_by, created_at
       FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC`,
    )
    .all(id) as Array<Omit<DbVersion, 'graph' | 'format_version'>>;
  return rows.map((r) => ({
    workflowId: r.workflow_id,
    version: r.version,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

export function appendVersion(
  db: Database,
  input: {
    workflowId: string;
    baseVersion: number;
    graph: WorkflowGraph;
    note: string | null;
    createdBy: string;
  },
  now: Date,
): WorkflowVersionRow {
  const ts = now.toISOString();
  return db
    .transaction(() => {
      const cur = db
        .prepare('SELECT current_version FROM workflows WHERE id = ? AND deleted_at IS NULL')
        .get(input.workflowId) as { current_version: number } | undefined;
      if (!cur) throw new NotFoundError(`Workflow ${input.workflowId} not found`);
      if (cur.current_version !== input.baseVersion) {
        throw new VersionConflictError(cur.current_version);
      }
      const version = input.baseVersion + 1;
      const row = insertVersionRow(db, {
        workflowId: input.workflowId,
        version,
        graph: input.graph,
        note: input.note,
        createdBy: input.createdBy,
        createdAt: ts,
      });
      db.prepare('UPDATE workflows SET current_version = ?, updated_at = ? WHERE id = ?').run(
        version,
        ts,
        input.workflowId,
      );
      return row;
    })
    .immediate();
}

export function renameWorkflow(db: Database, id: string, name: string, now: Date): boolean {
  const r = db
    .prepare('UPDATE workflows SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(name, now.toISOString(), id);
  return r.changes > 0;
}

/**
 * Points real runs at `version` and binds the workflow to `libraryId` (its Library input's library;
 * null: none) in the same UPDATE. Throws NotFoundError when that version row is missing; false when
 * the workflow is missing or deleted. A library another live workflow holds makes SQLite throw
 * SQLITE_CONSTRAINT_UNIQUE (the caller maps it). The kind is the service's check (the schema
 * refuses an active sub-workflow too). Neither this nor clearActiveVersion moves `updated_at`: it
 * stays the time of the last edit; `activated_at` is the activation time.
 */
export function setActiveVersion(
  db: Database,
  id: string,
  version: number,
  activatedBy: string,
  now: Date,
  libraryId: string | null,
): boolean {
  return db
    .transaction(() => {
      if (!findWorkflow(db, id)) return false;
      if (!findVersion(db, id, version)) {
        throw new NotFoundError(`Workflow ${id} has no version ${version}`);
      }
      const r = db
        .prepare(
          `UPDATE workflows SET active_version = ?, activated_at = ?, activated_by = ?,
             active_library_id = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(version, now.toISOString(), activatedBy, libraryId, id);
      return r.changes > 0;
    })
    .immediate();
}

/**
 * Real runs stop: all three activation columns and the library binding go to NULL. False when
 * missing or deleted.
 */
export function clearActiveVersion(db: Database, id: string): boolean {
  const r = db
    .prepare(
      `UPDATE workflows SET active_version = NULL, activated_at = NULL, activated_by = NULL,
         active_library_id = NULL
       WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(id);
  return r.changes > 0;
}

/** The live, active workflow that takes files from `libraryId`; null when none does. */
export function findFeeder(
  db: Database,
  libraryId: string,
): { workflowId: string; name: string; version: number } | null {
  const row = db
    .prepare(
      `SELECT id, name, active_version FROM workflows
       WHERE active_library_id = ? AND deleted_at IS NULL AND active_version IS NOT NULL`,
    )
    .get(libraryId) as { id: string; name: string; active_version: number } | undefined;
  return row ? { workflowId: row.id, name: row.name, version: row.active_version } : null;
}

/** A workflow version that names a library (`findFeeder`'s shape). */
export interface LibraryNamer {
  workflowId: string;
  name: string;
  version: number;
}

/**
 * Per library id: the live workflows whose newest version's Library input names that library while
 * that version is not active (never activated, or another version is), most recently edited first.
 * Activating that version would make it the library's feeder. Graphs that do not parse are skipped.
 */
export function listInactiveNamers(db: Database): Map<string, LibraryNamer[]> {
  const rows = db
    .prepare(
      `SELECT w.id, w.name, w.current_version, v.workflow_id, v.version, v.graph, v.format_version,
              v.note, v.created_by, v.created_at
       FROM workflows w
       JOIN workflow_versions v ON v.workflow_id = w.id AND v.version = w.current_version
       WHERE w.deleted_at IS NULL AND w.kind = 'workflow'
         AND (w.active_version IS NULL OR w.active_version <> w.current_version)
         AND instr(v.graph, ?) > 0
       ORDER BY w.updated_at DESC, w.name, w.id`,
    )
    .all(LIBRARY_INPUT_TYPE) as Array<
    DbVersion & { id: string; name: string; current_version: number }
  >;
  const byLibrary = new Map<string, LibraryNamer[]>();
  for (const r of rows) {
    const stored = toStoredVersion(r);
    const libraryId = stored.ok ? libraryInputOf(stored.row.graph)?.libraryId : undefined;
    if (!libraryId) continue;
    const namer = { workflowId: r.id, name: r.name, version: r.current_version };
    byLibrary.set(libraryId, [...(byLibrary.get(libraryId) ?? []), namer]);
  }
  return byLibrary;
}

export function softDeleteWorkflow(db: Database, id: string, now: Date): boolean {
  const ts = now.toISOString();
  const r = db
    .prepare(
      'UPDATE workflows SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    )
    .run(ts, ts, id);
  return r.changes > 0;
}
