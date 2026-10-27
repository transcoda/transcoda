import { NotFoundError, VersionConflictError } from '../../db/repos/workflows.ts';
import { KindMismatchError } from '../../workflows/service.ts';
import { os, requireHumanSession, requireScope } from '../middleware.ts';
import { redactGraph, redactSettings, restoreRedacted } from '../redact.ts';

// Reads (and validate, which stores nothing) need `read`; changes need `workflows:write`.
// A CorruptGraphError from the service is not mapped: it surfaces as a 500 (logged once by the handlers).
// Webhook URLs are write-only (redact.ts): get shows them as `scheme://host/…`; save accepts that
// form back for the stored value it stands for (any version of the same node), and refuses one
// that matches none (HIDDEN_URL_UNKNOWN) rather than storing the literal. create and duplicate
// return a redacted graph like get (every graph returned is redacted); list, versions and save
// return no graph.

export const list = os.workflows.list
  .use(requireScope('read'))
  .handler(({ context }) => ({ workflows: context.deps.workflows.list() }));

export const get = os.workflows.get
  .use(requireScope('read'))
  .handler(({ context, input, errors }) => {
    const detail = context.deps.workflows.get(input.id, input.version);
    if (!detail) throw errors.NOT_FOUND();
    return {
      ...detail,
      graph: redactGraph(detail.graph),
      settings: redactSettings(detail.settings, detail.graph),
    };
  });

export const create = os.workflows.create
  .use(requireScope('workflows:write'))
  .handler(({ context, input, errors }) => {
    // A redacted URL in a brand-new graph matches nothing stored: refused, never kept as a literal.
    let graph = input.graph && context.deps.workflows.upgradeInput(input.graph);
    if (graph) {
      const restored = restoreRedacted(graph, []);
      if (restored.unresolved.length > 0) {
        throw errors.HIDDEN_URL_UNKNOWN({ data: { nodeIds: restored.unresolved } });
      }
      graph = restored.graph;
    }
    try {
      const detail = context.deps.workflows.create({ ...input, graph }, context.auth.user.id);
      return {
        ...detail,
        graph: redactGraph(detail.graph),
        settings: redactSettings(detail.settings, detail.graph),
      };
    } catch (e) {
      if (e instanceof KindMismatchError) throw errors.KIND_MISMATCH({ message: e.message });
      throw e;
    }
  });

export const duplicate = os.workflows.duplicate
  .use(requireScope('workflows:write'))
  .handler(({ context, input, errors }) => {
    const result = context.deps.workflows.duplicate(
      input.id,
      input.name,
      context.auth.user.id,
      input.note,
    );
    if (result.kind === 'not-found') throw errors.NOT_FOUND();
    const { detail } = result;
    return {
      ...detail,
      graph: redactGraph(detail.graph),
      settings: redactSettings(detail.settings, detail.graph),
      sourceVersion: result.sourceVersion,
      droppedWebhookUrls: result.droppedNodeIds,
    };
  });

export const save = os.workflows.save
  .use(requireScope('workflows:write'))
  .handler(({ context, input, errors }) => {
    // Redacted URLs sent back are the stored values they stand for: looked up in the restored-from
    // version, the base version, then every other version newest first.
    const first = [input.restoredFrom, input.baseVersion].filter((v) => v !== undefined);
    const { graph, unresolved } = restoreRedacted(
      context.deps.workflows.upgradeInput(input.graph),
      context.deps.workflows.storedGraphs(input.id, first),
    );
    if (unresolved.length > 0) {
      // An unknown workflow has no versions to match against: that is the error to report.
      if (context.deps.workflows.versions(input.id) === null) throw errors.NOT_FOUND();
      throw errors.HIDDEN_URL_UNKNOWN({ data: { nodeIds: unresolved } });
    }
    try {
      return context.deps.workflows.save({ ...input, graph }, context.auth.user.id);
    } catch (e) {
      if (e instanceof NotFoundError) throw errors.NOT_FOUND();
      if (e instanceof VersionConflictError) {
        throw errors.VERSION_CONFLICT({ data: { currentVersion: e.currentVersion } });
      }
      if (e instanceof KindMismatchError) throw errors.KIND_MISMATCH({ message: e.message });
      throw e;
    }
  });

export const validate = os.workflows.validate
  .use(requireScope('read'))
  .handler(({ context, input }) => context.deps.workflows.validate(input.graph, input.id));

// Session-only: any API token is refused (requireHumanSession); no MCP tool wraps these.
export const activate = os.workflows.activate
  .use(requireHumanSession)
  .handler(({ context, input, errors }) => {
    const result = context.deps.workflows.activate(input.id, input.version, context.auth.user.id);
    if (result.kind === 'not-found') {
      throw errors.NOT_FOUND({
        message: result.what === 'version' ? 'Workflow version not found' : 'Workflow not found',
      });
    }
    if (result.kind === 'kind-mismatch') {
      throw errors.KIND_MISMATCH({
        message: 'A sub-workflow is never active; it runs as part of a workflow',
      });
    }
    if (result.kind === 'invalid')
      throw errors.WORKFLOW_INVALID({ data: { issues: result.issues } });
    if (result.kind === 'library-missing') {
      throw errors.LIBRARY_MISSING({ data: { libraryId: result.libraryId } });
    }
    if (result.kind === 'library-taken') {
      const { library, workflow } = result;
      throw errors.LIBRARY_TAKEN({
        message: `${library.name} is fed by ${workflow.name} v${workflow.version}. Deactivate it or point this Library input elsewhere.`,
        data: { library, workflow },
      });
    }
    return result.summary;
  });

export const deactivate = os.workflows.deactivate
  .use(requireHumanSession)
  .handler(({ context, input, errors }) => {
    const result = context.deps.workflows.deactivate(input.id);
    if (result.kind === 'not-found') throw errors.NOT_FOUND();
    if (result.kind === 'kind-mismatch') {
      throw errors.KIND_MISMATCH({
        message: 'A sub-workflow is never active; it runs as part of a workflow',
      });
    }
    return result.summary;
  });

export const rename = os.workflows.rename
  .use(requireScope('workflows:write'))
  .handler(({ context, input, errors }) => {
    const summary = context.deps.workflows.rename(input.id, input.name);
    if (!summary) throw errors.NOT_FOUND();
    return summary;
  });

export const remove = os.workflows.delete
  .use(requireScope('workflows:write'))
  .handler(({ context, input, errors }) => {
    const result = context.deps.workflows.delete(input.id);
    if (result.kind === 'not-found') throw errors.NOT_FOUND();
    if (result.kind === 'in-use') throw errors.IN_USE({ data: { usedBy: result.usedBy } });
    return { ok: true as const };
  });

export const versions = os.workflows.versions
  .use(requireScope('read'))
  .handler(({ context, input, errors }) => {
    const list = context.deps.workflows.versions(input.id);
    if (!list) throw errors.NOT_FOUND();
    return { versions: list };
  });
