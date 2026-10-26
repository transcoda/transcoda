import { join } from 'node:path';
import type { RunSummary } from '@transcoda/contract';
import { PathStringSchema, RunCountsSchema, RunDetailSchema } from '@transcoda/contract';
import { z } from 'zod';
import { type AnyToolDef, defineTool } from '../tool.ts';

/** The most folders and the most files `browse_library` lists in its text (the structured output has all). */
const BROWSE_TEXT_LINES = 200;

export const RunBriefShape = {
  id: z.string(),
  libraryName: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  workflowVersion: z.number().int(),
  requestedPath: z.string(),
  dryRun: z.boolean(),
  force: z.boolean(),
  createdAt: z.iso.datetime(),
  counts: RunCountsSchema,
};
export type RunBrief = z.infer<z.ZodObject<typeof RunBriefShape>>;

export function runBrief(s: RunSummary): RunBrief {
  const { run } = s;
  return {
    id: run.id,
    libraryName: s.libraryName,
    workflowId: run.workflowId,
    workflowName: s.workflowName,
    workflowVersion: run.workflowVersion,
    requestedPath: run.requestedPath,
    dryRun: run.dryRun,
    force: run.force,
    createdAt: run.createdAt,
    counts: s.counts,
  };
}

export function runLine(r: RunBrief): string {
  return (
    `${r.id} ${r.dryRun ? '[dry run] ' : ''}${r.workflowName} v${r.workflowVersion} ` +
    `on ${r.requestedPath}: ${r.counts.total} files, ${r.counts.queued} queued, ${r.counts.in_progress} in progress, ` +
    (r.dryRun
      ? `${r.counts.done + r.counts.dry_run - r.counts.dependsOnSize} would replace, ` +
        (r.counts.dependsOnSize > 0 ? `${r.counts.dependsOnSize} depend on size, ` : '') +
        `${r.counts.kept_original} would keep original, ${r.counts.nothing_to_do} nothing to do, `
      : `${r.counts.done} replaced, `) +
    `${r.counts.failed} failed`
  );
}

const WorkflowVersionShape = z.object({
  workflowId: z.string(),
  name: z.string(),
  version: z.number().int(),
});

const listLibraries = defineTool({
  name: 'list_libraries',
  title: 'List libraries',
  description:
    'The media libraries: id, name, root path, recycle folder and the active workflow that takes files from each (its Library input), or else the workflows whose newest version names it but is not active. Paths given to dry_run must be inside a library root.',
  scopes: ['read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: {},
  output: {
    libraries: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        path: z.string().describe('The library root (absolute)'),
        recycleFolder: z.string().nullable(),
        feeds: WorkflowVersionShape.nullable().describe(
          'The active workflow that takes files from this library; null: none',
        ),
        namedByInactive: z
          .array(WorkflowVersionShape)
          .describe(
            "With no feeder: workflows whose newest version's Library input names this library but is not active; activating that version makes it the feeder",
          ),
      }),
    ),
  },
  async run({ api }) {
    const { libraries } = await api.libraries.list();
    const brief = libraries.map(({ id, name, path, recycleFolder, feeds, namedByInactive }) => ({
      id,
      name,
      path,
      recycleFolder,
      feeds,
      namedByInactive,
    }));
    const namedBy = (l: (typeof brief)[number]) =>
      l.namedByInactive.length > 0
        ? `; named by ${l.namedByInactive.map((w) => `${w.name} v${w.version}`).join(', ')} (not active)`
        : '';
    const lines = brief.map(
      (l) =>
        `${l.name} (${l.id}): ${l.path}${
          l.feeds
            ? `, fed by ${l.feeds.name} v${l.feeds.version}`
            : `, no workflow takes files from it${namedBy(l)}`
        }`,
    );
    return {
      text: lines.length > 0 ? lines.join('\n') : 'No libraries.',
      data: { libraries: brief },
    };
  },
});

const browseLibrary = defineTool({
  name: 'browse_library',
  title: 'Browse a library folder',
  description:
    'List the sub-folders and media files of a folder in a library. Every returned path is absolute and can be given to dry_run.',
  scopes: ['read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: {
    libraryId: z.string().describe('A library id from list_libraries'),
    path: z.string().default('').describe('Folder relative to the library root; empty is the root'),
  },
  output: {
    root: z.string(),
    dirs: z.array(z.object({ name: z.string(), path: z.string() })),
    files: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        sizeBytes: z.number().int(),
        mtime: z.iso.datetime(),
      }),
    ),
  },
  async run({ api }, { libraryId, path }) {
    const library = await api.libraries.get({ id: libraryId });
    const root = library.path;
    const listing = await api.libraries.browse({ id: libraryId, path });
    const dirs = listing.dirs.map((name) => ({ name, path: join(root, path, name) }));
    const files = listing.files.map((f) => ({ ...f, path: join(root, path, f.name) }));
    const lines = [`${join(root, path)}: ${dirs.length} folders, ${files.length} media files`];
    for (const d of dirs.slice(0, BROWSE_TEXT_LINES)) lines.push(`d ${d.path}`);
    if (dirs.length > BROWSE_TEXT_LINES) {
      lines.push(`…and ${dirs.length - BROWSE_TEXT_LINES} more folders`);
    }
    for (const f of files.slice(0, BROWSE_TEXT_LINES))
      lines.push(`f ${f.path} (${f.sizeBytes} bytes)`);
    if (files.length > BROWSE_TEXT_LINES) {
      lines.push(`…and ${files.length - BROWSE_TEXT_LINES} more files`);
    }
    return { text: lines.join('\n'), data: { root, dirs, files } };
  },
});

const listRuns = defineTool({
  name: 'list_runs',
  title: 'List runs',
  description: 'Recent runs (one per queue request), newest first, with per-outcome counts.',
  scopes: ['read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: { limit: z.number().int().min(1).max(200).default(20).describe('How many runs') },
  output: { runs: z.array(z.object(RunBriefShape)) },
  async run({ api }, { limit }) {
    const { runs } = await api.runs.list({ limit });
    const briefs = runs.map(runBrief);
    return {
      text: briefs.length > 0 ? briefs.map(runLine).join('\n') : 'No runs.',
      data: { runs: briefs },
    };
  },
});

const getRun = defineTool({
  name: 'get_run',
  title: 'Get a run',
  description:
    'One run with its counts and its files (job id, state, reason). Use get_job for a file’s detail.',
  scopes: ['read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: {
    id: z.string().describe('A run id'),
    limit: z.number().int().min(1).max(1000).default(50).describe('How many files to list'),
  },
  output: {
    ...RunBriefShape,
    files: z.array(RunDetailSchema.shape.files.element),
    total: z.number().int().describe('Files in the run'),
  },
  async run({ api }, { id, limit }) {
    const detail = await api.runs.get({ id });
    const brief = runBrief(detail);
    const files = detail.files.slice(0, limit);
    const total = detail.files.length;
    const lines = [
      runLine(brief),
      ...files.map(
        (f) =>
          `${f.state} ${f.jobId} ${f.fileName}${f.reason ? ` — ${f.reason}` : ''}${f.dependsOnSize ? ` — would replace if it saves ≥ ${f.dependsOnSize.minSavingPercent}% (decided after encoding)` : ''}`,
      ),
    ];
    if (files.length < total) lines.push(`The list shows ${files.length} of ${total} files.`);
    return { text: lines.join('\n'), data: { ...brief, files, total } };
  },
});

const dryRun = defineTool({
  name: 'dry_run',
  title: 'Queue a dry run',
  description:
    'Queue a dry run of a workflow on a media file or folder inside a library. A dry run plans and decides but changes nothing on disk. The newest saved version is used unless `version` names one; a version that cannot run is refused. Real runs cannot be started through MCP; dry_run never runs for real. Use `version`, not workflowVersion; unknown arguments are refused. With testEncode the dry run encodes and verifies the file and reports the measured size; nothing in the library is written either way.',
  strict: true,
  scopes: ['plan', 'jobs:create'],
  annotations: { openWorldHint: false },
  input: {
    path: PathStringSchema.min(1).describe(
      'Absolute path of a media file or folder inside a library (see browse_library)',
    ),
    workflowId: z
      .string()
      .optional()
      .describe(
        'A workflow id; default: the workflow that library feeds (newest version unless version is given)',
      ),
    version: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('The workflow version to plan with; default the newest'),
    force: z.boolean().default(false).describe('Also queue files this version already finished'),
    priority: z.number().int().min(-10).max(10).default(0).describe('Higher runs first'),
    testEncode: z
      .boolean()
      .default(false)
      .describe(
        'Also encode, verify and measure for real (slow; uses the encode lane); still writes nothing to the library',
      ),
  },
  output: {
    runId: z.string(),
    jobIds: z.array(z.string()),
    dryRun: z.literal(true),
    testEncode: z.boolean().describe('Whether the dry run encodes and measures for real'),
    version: z.number().int().describe('The workflow version the dry run plans with'),
  },
  async run({ api }, { path, workflowId, version, force, priority, testEncode }) {
    const { runId, jobIds, workflowVersion } = await api.jobs.queue({
      path,
      ...(workflowId !== undefined ? { workflowId } : {}),
      dryRun: true,
      ...(version !== undefined ? { workflowVersion: version } : {}),
      force,
      priority,
      testEncode,
    });
    const first = jobIds[0];
    const what = testEncode ? 'Test-encode dry run' : 'Dry run';
    const changes = testEncode
      ? 'Each file is encoded, verified and measured; nothing in the library is written.'
      : 'Nothing on disk changes.';
    return {
      text:
        first === undefined
          ? `${what} ${runId} of v${workflowVersion} queued, but no media files were found: nothing was queued.`
          : `${what} ${runId} of v${workflowVersion} queued: ${jobIds.length} file(s). ${changes} ` +
            `Next: get_job ${first} for the plan and decisions (poll until its state is final: done, failed, cancelled, skipped, nothing_to_do, kept_original, dry_run or already_processed).`,
      data: { runId, jobIds, dryRun: true as const, testEncode, version: workflowVersion },
    };
  },
});

export const libraryTools: AnyToolDef[] = [listLibraries, browseLibrary, listRuns, getRun, dryRun];
