import type { Migration } from '../migrate.ts';
import type { Database } from '../open.ts';

/**
 * The active version's Library input becomes the one binding between a library and a workflow:
 * `workflows.active_library_id` (one live feeder per library) replaces
 * `libraries.default_workflow_id`. Each library's old default is bound, its trigger swapped into a
 * Library input as a new version where needed; conflicts become notices (a settings row and the
 * log). Frozen SQL: every table, column, node type and settings key is spelled literally here and
 * graphs are read with JSON.parse only. Rebuilds `libraries`, so it runs with foreign keys off.
 */

const LIBRARY_INPUT = 'core:input-library';
const TRIGGERS = new Set([LIBRARY_INPUT, 'core:input-manual', 'core:input-webhook']);
const BY = 'system:migration';
const NOTICES_KEY = 'libraries.migrationNotices';

interface Wf {
  id: string;
  kind: string;
  name: string;
  current_version: number;
  active_version: number | null;
  deleted_at: string | null;
}

interface Lib {
  id: string;
  name: string;
  default_workflow_id: string | null;
}

type Obj = Record<string, unknown>;
interface Graph extends Obj {
  nodes: Obj[];
}

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The parsed graph; null when the text is not JSON or has no node list. */
function parse(text: string | null): Graph | null {
  if (text === null) return null;
  let g: unknown;
  try {
    g = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(g) || !Array.isArray(g.nodes) || !g.nodes.every(isObj)) return null;
  return g as Graph;
}

/** The index of the graph's single trigger node; null with none, several, or an unreadable graph. */
function triggerIndex(g: Graph | null): number | null {
  if (g === null) return null;
  const found = g.nodes.flatMap((n, i) => (TRIGGERS.has(n.type as string) ? [i] : []));
  return found.length === 1 ? (found[0] as number) : null;
}

/** The library id a graph's single Library input names; null otherwise. */
function libraryIdOf(g: Graph | null): string | null {
  const i = triggerIndex(g);
  if (g === null || i === null) return null;
  const n = g.nodes[i] as Obj;
  if (n.type !== LIBRARY_INPUT || !isObj(n.settings)) return null;
  const id = n.settings.libraryId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** The graph with its trigger swapped for a Library input naming `libraryId`; null if unconvertible. */
function swapped(g: Graph | null, libraryId: string): string | null {
  const i = triggerIndex(g);
  if (g === null || i === null) return null;
  const nodes = g.nodes.map((n, j) =>
    j === i ? { ...n, type: LIBRARY_INPUT, typeVersion: 1, settings: { libraryId } } : n,
  );
  return JSON.stringify({ ...g, nodes });
}

function run(db: Database, log: (msg: string) => void): void {
  const now = new Date().toISOString();
  db.exec('ALTER TABLE workflows ADD COLUMN active_library_id TEXT;');

  const libs = db
    .prepare(
      'SELECT id, name, default_workflow_id FROM libraries WHERE deleted_at IS NULL ORDER BY name, id',
    )
    .all() as Lib[];
  const libById = new Map(libs.map((l) => [l.id, l]));
  const wfs = db
    .prepare(
      'SELECT id, kind, name, current_version, active_version, deleted_at FROM workflows ORDER BY name, id',
    )
    .all() as Wf[];
  const wfById = new Map(wfs.map((w) => [w.id, w]));
  const versionRow = db.prepare(
    'SELECT graph, format_version FROM workflow_versions WHERE workflow_id = ? AND version = ?',
  );
  const row = (w: Wf, v: number) =>
    versionRow.get(w.id, v) as { graph: string; format_version: number } | undefined;
  const graphOf = (w: Wf, v: number | null): Graph | null =>
    v === null ? null : parse(row(w, v)?.graph ?? null);
  const live = (w: Wf | undefined): w is Wf =>
    w !== undefined && w.deleted_at === null && w.kind === 'workflow';
  /** The live library W's active Library input names, else null. */
  const nodeLib = (w: Wf): string | null => {
    const id = libraryIdOf(graphOf(w, w.active_version));
    return id !== null && libById.has(id) ? id : null;
  };

  const insertVersion = db.prepare(
    `INSERT INTO workflow_versions (workflow_id, version, graph, format_version, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  /** Appends `text` as W's next version (format_version copied from `from`); returns its number. */
  const append = (w: Wf, from: number, text: string, library: Lib): number => {
    const version = w.current_version + 1;
    insertVersion.run(
      w.id,
      version,
      text,
      row(w, from)?.format_version ?? 1,
      `Library input set to ${library.name} (from its default workflow)`,
      BY,
      now,
    );
    w.current_version = version;
    db.prepare('UPDATE workflows SET current_version = ?, updated_at = ? WHERE id = ?').run(
      version,
      now,
      w.id,
    );
    return version;
  };

  /**
   * Phase 1's notices about a library left unfed, built once phase 2 has bound active Library
   * inputs: a library phase 2 bound has a feeder after all, so its notice is dropped, or reworded
   * when it says something still worth knowing (`ifBound`).
   */
  const unfed: { library: Lib; text: string; ifBound?: (feeder: Wf) => string }[] = [];
  const notices: string[] = [];
  const bound = new Map<string, Wf>(); // library id → its feeder
  const boundWf = new Set<string>();
  const bind = (libraryId: string, w: Wf) => {
    bound.set(libraryId, w);
    boundWf.add(w.id);
  };
  const n1 = (l: Lib, w: Wf, t: Lib) =>
    unfed.push({
      library: l,
      text: `${l.name} has no workflow now: its default, ${w.name}, takes files from ${t.name} instead. Add a Library input to a workflow for ${l.name}.`,
    });
  const n4 = (l: Lib, w: Wf) =>
    unfed.push({
      library: l,
      text: `${l.name} has no workflow now: its default, ${w.name}, could not be switched to a Library input. Add one to ${w.name} by hand.`,
    });

  // Phase 1: each live default workflow and the live libraries it was the default of.
  const defaultsOf = new Map<string, Lib[]>();
  for (const l of libs) {
    const w = l.default_workflow_id === null ? undefined : wfById.get(l.default_workflow_id);
    if (!live(w)) continue;
    defaultsOf.set(w.id, [...(defaultsOf.get(w.id) ?? []), l]);
  }
  for (const w of wfs) {
    const d = defaultsOf.get(w.id);
    if (!d) continue;
    const first = d[0] as Lib;
    if (w.active_version !== null) {
      const active = w.active_version;
      const activeGraph = graphOf(w, active);
      if (triggerIndex(activeGraph) === null) {
        for (const l of d) n4(l, w);
        continue;
      }
      const named = nodeLib(w);
      if (named !== null && d.some((l) => l.id === named)) {
        bind(named, w);
        const t = libById.get(named) as Lib;
        for (const l of d) if (l.id !== named) n1(l, w, t);
        continue;
      }
      if (named !== null) {
        // The node wins: W is left for phase 2, its old libraries go unfed.
        const other = libById.get(named) as Lib;
        for (const l of d) {
          unfed.push({
            library: l,
            text: `${l.name} has no workflow now: its default, ${w.name}, has a Library input that takes files from ${other.name}.`,
          });
        }
        continue;
      }
      const draft = w.current_version > active ? w.current_version : null;
      const next = append(w, active, swapped(activeGraph, first.id) as string, first);
      db.prepare(
        'UPDATE workflows SET active_version = ?, activated_at = ?, activated_by = ? WHERE id = ?',
      ).run(next, now, BY, w.id);
      w.active_version = next;
      if (draft !== null) {
        // The draft stays newest: swapped when it can be, copied unchanged when it cannot.
        const text = swapped(graphOf(w, draft), first.id) ?? (row(w, draft)?.graph as string);
        append(w, draft, text, first);
      }
      bind(first.id, w);
      for (const l of d.slice(1)) n1(l, w, first);
      continue;
    }
    // Not active: only the newest version gets a swapped copy; nothing is activated or bound.
    const newest = graphOf(w, w.current_version);
    if (triggerIndex(newest) === null) {
      for (const l of d) n4(l, w);
      continue;
    }
    if (libraryIdOf(newest) !== first.id) {
      append(w, w.current_version, swapped(newest, first.id) as string, first);
    }
    const newestVersion = w.current_version;
    unfed.push({
      library: first,
      text: `${first.name} has no workflow now: its default, ${w.name}, has no active version. Activate ${w.name} v${newestVersion} to feed ${first.name}.`,
      ifBound: (feeder) =>
        `${first.name} is fed by ${feeder.name} (its Library input). Its old default, ${w.name}, has no active version; its newest version v${newestVersion} also takes files from ${first.name}.`,
    });
    for (const l of d.slice(1)) n1(l, w, first);
  }

  // Phase 2: active workflows whose Library input names a live library claim it, first by name.
  const deactivated: string[] = [];
  for (const w of wfs) {
    if (!live(w) || w.active_version === null || boundWf.has(w.id)) continue;
    const named = nodeLib(w);
    if (named === null) continue;
    const holder = bound.get(named);
    if (holder === undefined) {
      bind(named, w);
      continue;
    }
    db.prepare(
      'UPDATE workflows SET active_version = NULL, activated_at = NULL, activated_by = NULL WHERE id = ?',
    ).run(w.id);
    w.active_version = null;
    deactivated.push(
      `${w.name} was deactivated: its Library input takes files from ${(libById.get(named) as Lib).name}, which ${holder.name} already feeds.`,
    );
  }

  for (const n of unfed) {
    const feeder = bound.get(n.library.id);
    if (feeder === undefined) notices.push(n.text);
    else if (n.ifBound) notices.push(n.ifBound(feeder));
  }
  notices.push(...deactivated);

  const setBinding = db.prepare('UPDATE workflows SET active_library_id = ? WHERE id = ?');
  for (const [libraryId, w] of bound) setBinding.run(libraryId, w.id);

  db.exec(`
CREATE UNIQUE INDEX workflows_active_library ON workflows(active_library_id)
  WHERE active_library_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE libraries_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  recycle_folder TEXT,
  process_hardlinked INTEGER NOT NULL DEFAULT 0 CHECK (process_hardlinked IN (0, 1)),
  verify_full_decode INTEGER NOT NULL DEFAULT 0 CHECK (verify_full_decode IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
INSERT INTO libraries_new (id, name, path, recycle_folder, process_hardlinked, verify_full_decode,
  created_at, updated_at, deleted_at)
SELECT id, name, path, recycle_folder, process_hardlinked, verify_full_decode,
  created_at, updated_at, deleted_at FROM libraries;
DROP TABLE libraries;
ALTER TABLE libraries_new RENAME TO libraries;
CREATE UNIQUE INDEX libraries_live_path ON libraries(path) WHERE deleted_at IS NULL;
`);

  if (notices.length > 0) {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(NOTICES_KEY, JSON.stringify(notices), now);
    for (const n of notices) log(`Migration 0008: ${n}`);
  }
}

export const libraryTrigger: Migration = {
  version: 8,
  name: '0008_library_trigger',
  foreignKeys: 'off',
  up: run,
};
