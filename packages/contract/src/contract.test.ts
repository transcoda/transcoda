import { readFileSync } from 'node:fs';
import { NODE_KINDS } from '@transcoda/sdk';
import * as shared from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import {
  AuthUserOutputSchema,
  CapabilitiesSchema,
  ChangePasswordInputSchema,
  CredentialsSchema,
  contract,
  EncodeDeviceSchema,
  EngineEventSchema,
  errorDefs,
  HealthInputSchema,
  JobSchema,
  JobsListInputSchema,
  JobsQueueInputSchema,
  JobsQueueOutputSchema,
  LibrariesListOutputSchema,
  LibraryCreateInputSchema,
  LibraryFeedsSchema,
  LibraryRefSchema,
  LibrarySchema,
  LibraryUpdateInputSchema,
  LicencesOutputSchema,
  MeOutputSchema,
  NodeInfoSchema,
  NodeKindSchema,
  PluginCatalogAddInputSchema,
  PluginCatalogOutputSchema,
  PluginDetailSchema,
  PluginRemoveInputSchema,
  PluginSettingsGetOutputSchema,
  PluginSummarySchema,
  PluginsListOutputSchema,
  PortSpecSchema,
  REMOVED_DEFAULT_WORKFLOW,
  RunDetailSchema,
  RunSchema,
  SecretMarkerSchema,
  SettingsUpdateInputSchema,
  ThirdPartyFileSchema,
  TokenCreateInputSchema,
  WorkflowActivateInputSchema,
  WorkflowCreateInputSchema,
  WorkflowDetailSchema,
  WorkflowDuplicateInputSchema,
  WorkflowSaveInputSchema,
  WorkflowSaveOutputSchema,
  WorkflowSummarySchema,
  WorkflowValidateInputSchema,
} from './index.ts';

describe('schemas', () => {
  it('NodeInfoSchema parses with and without finishPhase (null for a non-finish node)', () => {
    const info = {
      type: 'core:replace-original',
      version: 1,
      kind: 'finish',
      title: 'Replace original',
      description: 'd',
      icon: 'i',
      inputs: [{ id: 'file', label: 'File', type: 'file' }],
      outputs: [],
      settingsSchema: {},
      onNodeSettings: [],
      source: { kind: 'core' },
      availability: { available: true },
    };
    expect(NodeInfoSchema.parse(info)).not.toHaveProperty('finishPhase');
    expect(NodeInfoSchema.parse({ ...info, finishPhase: 'write' }).finishPhase).toBe('write');
    expect(NodeInfoSchema.parse({ ...info, finishPhase: null }).finishPhase).toBeNull();
    expect(NodeInfoSchema.safeParse({ ...info, finishPhase: 'later' }).success).toBe(false);
    expect(NodeInfoSchema.parse({ ...info, damagedOnly: true }).damagedOnly).toBe(true);
    expect(NodeInfoSchema.parse(info)).not.toHaveProperty('damagedOnly');
  });

  it("PortSpecSchema keeps a port's shownWhen", () => {
    const shownWhen = { setting: 'qualityCheck', equals: true };
    const port = { id: 'damaged', label: 'Damaged', type: 'file', shownWhen };
    expect(PortSpecSchema.parse(port).shownWhen).toEqual(shownWhen);
    expect(PortSpecSchema.safeParse({ ...port, shownWhen: { equals: true } }).success).toBe(false);
  });

  it('rejects short passwords and usernames with spaces', () => {
    expect(CredentialsSchema.safeParse({ username: 'admin', password: 'short' }).success).toBe(
      false,
    );
    expect(
      CredentialsSchema.safeParse({ username: 'ad min', password: 'x'.repeat(12) }).success,
    ).toBe(false);
    expect(
      CredentialsSchema.safeParse({ username: 'admin', password: 'x'.repeat(12) }).success,
    ).toBe(true);
  });

  it('validates token creation input', () => {
    expect(
      TokenCreateInputSchema.safeParse({ name: 'diskmap', scopes: ['plan', 'jobs:create'] })
        .success,
    ).toBe(true);
    expect(TokenCreateInputSchema.safeParse({ name: 'diskmap', scopes: [] }).success).toBe(false);
    expect(TokenCreateInputSchema.safeParse({ name: 'diskmap', scopes: ['admin'] }).success).toBe(
      false,
    );
  });

  it('accepts an unavailable capabilities report', () => {
    expect(
      CapabilitiesSchema.safeParse({
        available: false,
        path: '/x',
        error: 'ENOENT',
        deviceProfiles: [{ id: 'chrome', name: 'Chrome (desktop)' }],
      }).success,
    ).toBe(true);
  });

  it('requires deviceProfiles in both capabilities variants', () => {
    expect(
      CapabilitiesSchema.safeParse({ available: false, path: '/x', error: 'ENOENT' }).success,
    ).toBe(false);
    const available = {
      available: true,
      path: '/usr/bin/ffmpeg',
      version: '9.0.2',
      encoders: [],
      hwaccels: [],
      filters: [],
    };
    expect(CapabilitiesSchema.safeParse(available).success).toBe(false);
    expect(CapabilitiesSchema.safeParse({ ...available, deviceProfiles: [] }).success).toBe(true);
    expect(
      CapabilitiesSchema.safeParse({ ...available, deviceProfiles: [{ id: 'tv', name: 'TV' }] })
        .success,
    ).toBe(false);
  });
});

describe('auth outputs', () => {
  it('wraps the user as { user }', () => {
    const user = { id: 'u1', username: 'admin', createdAt: '2026-01-01T00:00:00Z' };
    expect(AuthUserOutputSchema.safeParse({ user }).success).toBe(true);
    expect(AuthUserOutputSchema.safeParse(user).success).toBe(false);
    for (const proc of [contract.auth.setup, contract.auth.login]) {
      const out = proc['~orpc'].outputSchema;
      expect(out?.['~standard'].validate({ user })).not.toHaveProperty('issues');
      expect(out?.['~standard'].validate(user)).toHaveProperty('issues');
    }
  });
});

describe('settings', () => {
  it('exposes get and a session-only update, after system', () => {
    expect(Object.keys(contract.settings)).toEqual(['get', 'update']);
    const keys = Object.keys(contract);
    expect(keys.indexOf('settings')).toBe(keys.indexOf('system') + 1);
    expect(contract.settings.get['~orpc'].route).toMatchObject({
      method: 'GET',
      path: '/settings',
    });
    expect(contract.settings.update['~orpc'].route).toMatchObject({
      method: 'PATCH',
      path: '/settings',
    });
    expect(contract.auth.changePassword['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/auth/password',
    });
  });

  it('the update input is a strict allow-list with bounds', () => {
    const refused: unknown[] = [
      {},
      { queuePaused: true },
      { 'recycle.retentionDays': 3 },
      { pluginCallTimeoutMs: 999 },
      { pluginCallTimeoutMs: 3_600_001 },
      { recycleMaxFreePercent: 101 },
      { recycleRetentionDays: 1.5 },
      { testEncodeKeepHours: 73 },
      { testEncodeKeepHours: 1.5 },
      { testEncodeKeepHours: -1 },
      { serverName: 'a\nb' },
      { serverName: 'x'.repeat(65) },
      { theme: 'sepia' },
    ];
    for (const input of refused) {
      expect(SettingsUpdateInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
    const accepted: unknown[] = [
      { serverName: null },
      { serverName: 'x'.repeat(64) },
      { theme: 'light' },
      { recycleRetentionDays: 0, recycleMaxFreePercent: 100 },
      { pluginCallTimeoutMs: 1_000 },
      { pluginCallTimeoutMs: 3_600_000 },
      { testEncodeKeepHours: 0 },
      { testEncodeKeepHours: 72 },
    ];
    for (const input of accepted) {
      expect(SettingsUpdateInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(true);
    }
  });

  it('auth.me carries the appearance', () => {
    const base = { setupRequired: false, user: null, csrfToken: null };
    expect(MeOutputSchema.safeParse(base).success).toBe(false);
    expect(
      MeOutputSchema.safeParse({ ...base, appearance: { theme: 'system', serverName: null } })
        .success,
    ).toBe(true);
    expect(
      MeOutputSchema.safeParse({ ...base, appearance: { theme: 'blue', serverName: null } })
        .success,
    ).toBe(false);
  });

  it('a new password follows the setup rule', () => {
    expect(
      ChangePasswordInputSchema.safeParse({ currentPassword: 'x', newPassword: 'a'.repeat(11) })
        .success,
    ).toBe(false);
    expect(
      ChangePasswordInputSchema.safeParse({ currentPassword: '', newPassword: 'a'.repeat(12) })
        .success,
    ).toBe(false);
    expect(
      ChangePasswordInputSchema.safeParse({ currentPassword: 'x', newPassword: 'a'.repeat(12) })
        .success,
    ).toBe(true);
  });
});

describe('contract', () => {
  it('exposes the expected procedures', () => {
    expect(Object.keys(contract.auth)).toEqual([
      'setup',
      'login',
      'logout',
      'me',
      'changePassword',
    ]);
    expect(Object.keys(contract.system)).toEqual([
      'health',
      'capabilities',
      'gpuLoad',
      'licences',
      'backups',
    ]);
    expect(Object.keys(contract.system.backups)).toEqual(['list', 'create']);
    expect(contract.system.backups.list['~orpc'].route).toMatchObject({
      method: 'GET',
      path: '/system/backups',
    });
    expect(contract.system.backups.create['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/system/backups',
    });
    expect(Object.keys(contract.tokens)).toEqual(['create', 'list', 'revoke']);
  });

  it('exposes nodes and workflows procedures', () => {
    expect(Object.keys(contract.nodes)).toEqual(['list']);
    expect(Object.keys(contract.workflows)).toEqual([
      'list',
      'get',
      'create',
      'save',
      'validate',
      'activate',
      'deactivate',
      'rename',
      'delete',
      'versions',
      'duplicate',
    ]);
  });

  it('workflows.create takes an optional graph and note; duplicate takes id, name, note', () => {
    const graph = { formatVersion: 2, kind: 'workflow', nodes: [], edges: [], groups: [] };
    expect(
      WorkflowCreateInputSchema.safeParse({ name: 'a', kind: 'workflow', graph, note: 'n' })
        .success,
    ).toBe(true);
    expect(
      WorkflowCreateInputSchema.safeParse({ name: 'a', kind: 'workflow', note: 'x'.repeat(121) })
        .success,
    ).toBe(false);
    expect(WorkflowDuplicateInputSchema.safeParse({ id: 'w', name: 'copy' }).success).toBe(true);
    expect(contract.workflows.duplicate['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/workflows/{id}/duplicate',
    });
  });

  it('exposes the engine routers', () => {
    expect(Object.keys(contract.libraries)).toEqual([
      'list',
      'get',
      'browse',
      'create',
      'update',
      'dismissNotices',
      'delete',
    ]);
    expect(Object.keys(contract.jobs)).toEqual([
      'queue',
      'list',
      'stats',
      'history',
      'get',
      'log',
      'pause',
      'resume',
      'retryFailed',
      'cancel',
      'cancelAll',
      'deleteTestOutput',
    ]);
    expect(contract.jobs.cancelAll['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/jobs/cancel-all',
    });
    expect(contract.jobs.deleteTestOutput['~orpc'].route).toMatchObject({
      method: 'DELETE',
      path: '/jobs/{id}/test-output',
      description: "A person's session only.",
    });
    expect(Object.keys(contract.queue)).toEqual(['status', 'pause', 'resume']);
    expect(Object.keys(contract.runs)).toEqual(['list', 'get']);
    expect(Object.keys(contract.events)).toEqual(['subscribe']);
  });

  it('exposes the plugins router', () => {
    expect(Object.keys(contract)).toContain('plugins');
    expect(Object.keys(contract.plugins)).toEqual([
      'list',
      'catalog',
      'catalogsAdd',
      'catalogsRemove',
      'get',
      'install',
      'update',
      'updateCheck',
      'remove',
      'enable',
      'disable',
      'restart',
      'settingsGet',
      'settingsSave',
      'settingsTest',
      'testMapping',
    ]);
  });

  it('exposes the fs router with one session-only browse procedure', () => {
    expect(Object.keys(contract.fs)).toEqual(['browseDirs']);
  });

  it('jobs.queue input defaults dryRun, force, fileOnly and priority and bounds priority', () => {
    expect(JobsQueueInputSchema.parse({ path: '/media/a.mkv' })).toEqual({
      path: '/media/a.mkv',
      dryRun: false,
      force: false,
      fileOnly: false,
      priority: 0,
    });
    expect(JobsQueueInputSchema.parse({ path: '/media/a.mkv', fileOnly: true }).fileOnly).toBe(
      true,
    );
    expect(JobsQueueInputSchema.safeParse({ path: '' }).success).toBe(false);
    expect(JobsQueueInputSchema.safeParse({ path: '/a', priority: 11 }).success).toBe(false);
    expect(JobsQueueInputSchema.safeParse({ path: '/a', priority: 1.5 }).success).toBe(false);
  });

  it('EngineEventSchema accepts ping and resync and rejects an unknown type', () => {
    const at = '2026-10-16T18:00:00.000Z';
    expect(EngineEventSchema.safeParse({ type: 'ping', at }).success).toBe(true);
    expect(EngineEventSchema.safeParse({ type: 'resync', at }).success).toBe(true);
    expect(EngineEventSchema.safeParse({ type: 'job.deleted', jobId: 'j' }).success).toBe(false);
    expect(
      EngineEventSchema.safeParse({
        type: 'job.changed',
        jobId: 'j',
        runId: 'r',
        libraryId: 'l',
        workflowId: 'w',
        state: 'encoding',
        paused: false,
        progress: null,
        lane: 'encode',
        currentNode: { workflowPath: [], nodeId: 'ev' },
        problems: ['finished with a problem: x'],
        reason: 'waiting for 5.4 GB free on /media (5.1 GB free)',
      }).success,
    ).toBe(true);
    expect(
      EngineEventSchema.safeParse({
        type: 'plugins.changed',
        name: 'example',
        state: 'stopped',
        stateReason: 'crashed 3 times in 10 minutes',
      }).success,
    ).toBe(true);
    expect(
      EngineEventSchema.safeParse({
        type: 'plugins.changed',
        name: 'example',
        state: 'running',
        stateReason: null,
      }).success,
    ).toBe(true);
    expect(JobsListInputSchema.parse({ problems: true }).problems).toBe(true);
    expect(
      EngineEventSchema.safeParse({
        type: 'queue.changed',
        paused: true,
        lanes: { encode: null, quick: 'j' },
        encodeSlots: [{ id: 'gpu:0', label: 'GPU 0', jobId: null }],
      }).success,
    ).toBe(true);
  });

  it('save declares HIDDEN_URL_UNKNOWN and takes restoredFrom (final review I3, I4)', () => {
    const errorsOf = (p: unknown) =>
      Object.keys((p as { '~orpc': { errorMap: Record<string, unknown> } })['~orpc'].errorMap);
    expect(errorsOf(contract.workflows.save)).toContain('HIDDEN_URL_UNKNOWN');
    const base = {
      id: 'w',
      baseVersion: 3,
      graph: { formatVersion: 2, kind: 'workflow', nodes: [], edges: [], groups: [] },
    };
    expect(WorkflowSaveInputSchema.parse({ ...base, restoredFrom: 1 }).restoredFrom).toBe(1);
    expect(WorkflowSaveInputSchema.safeParse({ ...base, restoredFrom: 0 }).success).toBe(false);
  });

  it('workflows router: activate and deactivate replace setMode', () => {
    const route = (p: unknown) =>
      (p as { '~orpc': { route: Record<string, unknown> } })['~orpc'].route;
    const errorsOf = (p: unknown) =>
      Object.keys((p as { '~orpc': { errorMap: Record<string, unknown> } })['~orpc'].errorMap);
    expect(route(contract.workflows.activate)).toMatchObject({
      method: 'POST',
      path: '/workflows/{id}/activate',
    });
    expect(route(contract.workflows.deactivate)).toMatchObject({
      method: 'POST',
      path: '/workflows/{id}/deactivate',
    });
    expect(errorsOf(contract.workflows.activate)).toEqual(
      expect.arrayContaining(['NOT_FOUND', 'KIND_MISMATCH', 'WORKFLOW_INVALID']),
    );
    expect(errorsOf(contract.workflows.deactivate)).toEqual(
      expect.arrayContaining(['NOT_FOUND', 'KIND_MISMATCH']),
    );
  });

  it('library trigger vocabulary: error codes, activate errors, LIBRARY_MISSING issue', () => {
    const errorsOf = (p: unknown) =>
      Object.keys((p as { '~orpc': { errorMap: Record<string, unknown> } })['~orpc'].errorMap);
    expect(errorDefs.LIBRARY_TAKEN.status).toBe(409);
    expect(errorDefs.LIBRARY_MISSING.status).toBe(400);
    expect(errorDefs.NO_FEEDING_WORKFLOW.status).toBe(400);
    expect('NO_DEFAULT_WORKFLOW' in errorDefs).toBe(false);
    expect(errorsOf(contract.jobs.queue)).toContain('NO_FEEDING_WORKFLOW');
    expect(errorsOf(contract.jobs.queue)).not.toContain('NO_DEFAULT_WORKFLOW');
    expect(
      errorDefs.LIBRARY_TAKEN.data.safeParse({
        library: { id: 'l', name: 'Shows' },
        workflow: { id: 'w', name: 'Shrink', version: 4 },
      }).success,
    ).toBe(true);
    expect(errorDefs.LIBRARY_MISSING.data.safeParse({ libraryId: 'gone' }).success).toBe(true);
    expect(errorsOf(contract.workflows.activate)).toEqual(
      expect.arrayContaining(['LIBRARY_TAKEN', 'LIBRARY_MISSING']),
    );
    expect(shared.ISSUE_CODES).toContain('LIBRARY_MISSING');
    expect(LibraryRefSchema.safeParse({ id: 'l', name: 'Shows' }).success).toBe(true);
    expect(LibraryFeedsSchema.safeParse(null).success).toBe(true);
    expect(
      LibraryFeedsSchema.safeParse({ workflowId: 'w', name: 'Shrink', version: 1.5 }).success,
    ).toBe(false);
    expect(
      LibraryFeedsSchema.safeParse({ workflowId: 'w', name: 'Shrink', version: 2 }).success,
    ).toBe(true);
  });

  it('library trigger read fields: feedsLibrary, libraryInput, feeds, notices, dismissNotices', () => {
    const AT = '2026-10-17T10:00:00.000Z';
    const summary = {
      id: 'w',
      name: 'A',
      kind: 'workflow',
      active: null,
      currentVersion: 1,
      valid: true,
      errorCount: 0,
      usesOutdatedSubworkflow: false,
      usedBy: [],
      createdAt: AT,
      updatedAt: AT,
    };
    expect(WorkflowSummarySchema.safeParse(summary).success).toBe(false);
    expect(
      WorkflowSummarySchema.safeParse({
        ...summary,
        feedsLibrary: { id: 'l', name: 'Shows' },
        libraryInput: { id: 'l', name: null },
      }).success,
    ).toBe(true);
    expect('feeds' in LibrarySchema.shape).toBe(true);
    expect(
      LibrarySchema.shape.namedByInactive.safeParse([
        { workflowId: 'w', name: 'Movie Cleanup', version: 5 },
      ]).success,
    ).toBe(true);
    expect(LibrarySchema.shape.namedByInactive.safeParse(null).success).toBe(false);
    expect(
      LibrariesListOutputSchema.safeParse({
        libraries: [],
        notices: ['Shows has no workflow now'],
        clock: { now: '2026-10-22T12:00:00.000Z', timeZone: 'Europe/Berlin' },
      }).success,
    ).toBe(true);
    expect(LibrariesListOutputSchema.safeParse({ libraries: [] }).success).toBe(false);
    expect(contract.libraries.dismissNotices['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/libraries/notices/dismiss',
    });
  });

  it('defaultWorkflowId is removed: DEFAULT_WORKFLOW_INVALID gone, the inputs refuse it with REMOVED_DEFAULT_WORKFLOW', () => {
    const errorsOf = (p: unknown) =>
      Object.keys((p as { '~orpc': { errorMap: Record<string, unknown> } })['~orpc'].errorMap);
    expect('DEFAULT_WORKFLOW_INVALID' in errorDefs).toBe(false);
    expect(errorsOf(contract.libraries.create)).not.toContain('DEFAULT_WORKFLOW_INVALID');
    expect(errorsOf(contract.libraries.update)).not.toContain('DEFAULT_WORKFLOW_INVALID');
    expect('defaultWorkflowId' in LibrarySchema.shape).toBe(false);
    expect(REMOVED_DEFAULT_WORKFLOW).toBe(
      "defaultWorkflowId was removed: a workflow's Library input chooses its library",
    );
    for (const [schema, base] of [
      [LibraryCreateInputSchema, { name: 'Shows', path: '/media/shows' }],
      [LibraryUpdateInputSchema, { id: 'l' }],
    ] as const) {
      expect(schema.safeParse(base).success).toBe(true);
      for (const value of ['w1', null]) {
        const parsed = schema.safeParse({ ...base, defaultWorkflowId: value });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.message).toBe(REMOVED_DEFAULT_WORKFLOW);
      }
    }
  });

  it('activate input requires confirm: true and a version >= 1', () => {
    const ok = WorkflowActivateInputSchema.safeParse;
    expect(ok({ id: 'w', version: 2 }).success).toBe(false);
    expect(ok({ id: 'w', version: 2, confirm: false }).success).toBe(false);
    expect(ok({ id: 'w', version: 0, confirm: true }).success).toBe(false);
    expect(ok({ id: 'w', version: 2, confirm: true }).success).toBe(true);
  });

  it('WorkflowSummarySchema takes active null or the object and no longer knows mode', () => {
    const AT = '2026-10-17T10:00:00.000Z';
    const base = {
      id: 'w',
      name: 'A',
      kind: 'workflow',
      currentVersion: 3,
      valid: true,
      errorCount: 0,
      usesOutdatedSubworkflow: false,
      usedBy: [],
      feedsLibrary: null,
      libraryInput: null,
      createdAt: AT,
      updatedAt: AT,
    };
    expect(WorkflowSummarySchema.safeParse({ ...base, active: null }).success).toBe(true);
    expect(
      WorkflowSummarySchema.safeParse({
        ...base,
        active: { version: 3, runnable: true, activatedAt: AT, activatedBy: 'u1' },
      }).success,
    ).toBe(true);
    expect(
      WorkflowSummarySchema.safeParse({ ...base, active: null, mode: 'enabled' }).success,
    ).toBe(true);
    expect('mode' in WorkflowSummarySchema.shape).toBe(false);
    expect('needsReview' in WorkflowSummarySchema.shape).toBe(false);
    expect('reviewNote' in WorkflowSummarySchema.shape).toBe(false);
    expect('WorkflowModeSchema' in shared).toBe(false);
  });

  it('jobs.queue input takes workflowVersion only with dryRun true; output carries dryRun and note', () => {
    expect(
      JobsQueueInputSchema.safeParse({ path: '/a', dryRun: true, workflowVersion: 2 }).success,
    ).toBe(true);
    expect(JobsQueueInputSchema.safeParse({ path: '/a', workflowVersion: 2 }).success).toBe(false);
    expect(
      JobsQueueInputSchema.safeParse({ path: '/a', dryRun: false, workflowVersion: 2 }).success,
    ).toBe(false);
    expect(
      JobsQueueOutputSchema.safeParse({
        runId: 'r',
        jobIds: [],
        dryRun: true,
        note: 'no active version',
        workflowVersion: 3,
        testEncode: false,
      }).success,
    ).toBe(true);
  });

  it('jobs.queue input takes testEncode only with dryRun true; Job, Run and the queue output carry it', () => {
    const real = JobsQueueInputSchema.safeParse({ path: '/a', dryRun: false, testEncode: true });
    expect(real.success).toBe(false);
    expect(real.error?.issues.map((i) => [i.path, i.message])).toEqual([
      [['testEncode'], 'only a dry run can test-encode'],
    ]);
    expect(JobsQueueInputSchema.safeParse({ path: '/a', testEncode: true }).success).toBe(false);
    expect(
      JobsQueueInputSchema.safeParse({ path: '/a', dryRun: false, testEncode: false }).success,
    ).toBe(true);
    const dry = JobsQueueInputSchema.parse({ path: '/a', dryRun: true });
    expect(dry.testEncode).toBeUndefined();
    expect(
      JobsQueueInputSchema.parse({ path: '/a', dryRun: true, testEncode: true }).testEncode,
    ).toBe(true);
    expect(JobSchema.shape.testEncode.safeParse(undefined).success).toBe(false);
    expect(RunSchema.shape.testEncode.safeParse(undefined).success).toBe(false);
    expect(JobsQueueOutputSchema.shape.testEncode.safeParse(true).success).toBe(true);
  });

  it('RunSchema carries note and RunDetail files carry workflowVersion', () => {
    expect('note' in RunSchema.shape).toBe(true);
    const files = RunDetailSchema.shape.files.element.shape;
    expect('workflowVersion' in files).toBe(true);
  });

  it('WorkflowSaveOutputSchema is { version, issues, valid, active, changes }', () => {
    expect(Object.keys(WorkflowSaveOutputSchema.shape)).toEqual([
      'version',
      'issues',
      'valid',
      'active',
      'changes',
    ]);
  });

  it('node schemas follow the sdk enums', () => {
    expect(NodeKindSchema.options).toEqual([...NODE_KINDS]);
    expect(PortSpecSchema.safeParse({ id: 'x', label: 'X', type: 'audio' }).success).toBe(false);
    expect(PortSpecSchema.safeParse({ id: 'x', label: 'X', type: 'data:language' }).success).toBe(
      true,
    );
  });

  it('save input takes an optional trimmed note of at most 120 characters', () => {
    const base = {
      id: 'w',
      baseVersion: 1,
      graph: { formatVersion: 2, kind: 'workflow', nodes: [], edges: [], groups: [] },
    };
    expect(WorkflowSaveInputSchema.parse({ ...base, note: ' Layout only ' }).note).toBe(
      'Layout only',
    );
    expect(WorkflowSaveInputSchema.parse(base).note).toBeUndefined();
    expect(WorkflowSaveInputSchema.safeParse({ ...base, note: 'x'.repeat(121) }).success).toBe(
      false,
    );
  });

  it('graph inputs take format 1 too (the server upgrades it); details carry format 2 only', () => {
    const v1 = { formatVersion: 1, kind: 'workflow', nodes: [], edges: [], groups: [] };
    expect(WorkflowSaveInputSchema.safeParse({ id: 'w', baseVersion: 1, graph: v1 }).success).toBe(
      true,
    );
    expect(
      WorkflowCreateInputSchema.safeParse({ name: 'a', kind: 'workflow', graph: v1 }).success,
    ).toBe(true);
    expect(WorkflowValidateInputSchema.safeParse({ graph: v1 }).success).toBe(true);
    expect(WorkflowDetailSchema.shape.graph.safeParse(v1).success).toBe(false);
  });

  it('save input rejects a structurally broken graph (groups missing)', () => {
    expect(
      WorkflowSaveInputSchema.safeParse({
        id: 'w',
        baseVersion: 1,
        graph: { formatVersion: 2, kind: 'workflow', nodes: [], edges: [] },
      }).success,
    ).toBe(false);
  });
});

const blocklist = {
  url: 'https://example.com/blocklist.json',
  error: null,
  fetchedAt: '2026-10-17T12:00:00.000Z',
  entries: 2,
};

describe('plugin schemas', () => {
  it('the summary carries no settings, secret, token or key field', () => {
    for (const key of Object.keys(PluginSummarySchema.shape)) {
      expect(key).not.toMatch(/settings|secret|token|key/i);
    }
  });

  it('settings answer parses a masked secret', () => {
    expect(
      PluginSettingsGetOutputSchema.safeParse({
        settings: { apiKey: { set: true } },
        lastTest: null,
        needsReview: null,
      }).success,
    ).toBe(true);
  });

  it('health takes an optional deep query and can answer UNHEALTHY with the checks', () => {
    expect(HealthInputSchema.safeParse(undefined).success).toBe(true);
    expect(HealthInputSchema.safeParse({}).success).toBe(true);
    expect(HealthInputSchema.safeParse({ deep: '1' }).success).toBe(true);
    expect(HealthInputSchema.safeParse({ deep: 'true' }).success).toBe(true);
    expect(HealthInputSchema.safeParse({ deep: 'yes' }).success).toBe(false);
    expect(errorDefs.UNHEALTHY.status).toBe(503);
    expect(
      errorDefs.UNHEALTHY.data.safeParse({
        status: 'fail',
        version: '1',
        checks: { database: 'ok', ffmpeg: 'fail', scratchSpace: 'ok', queue: 'ok' },
      }).success,
    ).toBe(true);
  });

  it('defines the plugin errors', () => {
    expect(errorDefs.PLUGIN_INSTALL_FAILED.status).toBe(422);
    expect(errorDefs.PLUGIN_SETTINGS_INVALID.status).toBe(422);
    expect(errorDefs.PLUGIN_NOT_RUNNING.status).toBe(409);
  });

  it('a catalog is added with optional <keyId>:<64 hex> signing keys', () => {
    expect(
      PluginCatalogAddInputSchema.safeParse({ url: 'https://example.com/c.json' }).success,
    ).toBe(true);
    const ok = { url: 'https://example.com/c.json', signingKeys: `k1:${'ab'.repeat(32)}` };
    expect(PluginCatalogAddInputSchema.safeParse(ok).success).toBe(true);
    const two = { ...ok, signingKeys: `k1:${'ab'.repeat(32)},k2:${'cd'.repeat(32)}` };
    expect(PluginCatalogAddInputSchema.safeParse(two).success).toBe(true);
    for (const signingKeys of [
      'ab',
      'ab'.repeat(32),
      `k1:${'AB'.repeat(32)}`,
      `k1:${'g'.repeat(64)}`,
      `k1:${'ab'.repeat(32)}0`,
      `:${'ab'.repeat(32)}`,
      `k1:${'ab'.repeat(32)},`,
    ]) {
      expect(PluginCatalogAddInputSchema.safeParse({ ...ok, signingKeys }).success).toBe(false);
    }
  });

  it('the catalog output carries signed, keyIds and each version its signature url', () => {
    const base = {
      catalogUrl: 'https://example.com/c.json',
      official: true,
      error: null,
      plugins: [],
    };
    expect(PluginCatalogOutputSchema.safeParse({ catalogs: [base], blocklist }).success).toBe(
      false,
    );
    expect(
      PluginCatalogOutputSchema.safeParse({ catalogs: [{ ...base, signed: true }], blocklist })
        .success,
    ).toBe(false);
    expect(
      PluginCatalogOutputSchema.safeParse({
        catalogs: [{ ...base, signed: true, keyIds: ['k1'] }],
        blocklist,
      }).success,
    ).toBe(true);
  });

  it('the catalog output carries the blocklist status, and a build or plugin its blocked reason', () => {
    const catalog = {
      catalogUrl: 'https://example.com/c.json',
      official: true,
      signed: true,
      keyIds: ['k1'],
      error: null,
      plugins: [],
    };
    expect(PluginCatalogOutputSchema.safeParse({ catalogs: [catalog] }).success).toBe(false);
    for (const bad of [
      { ...blocklist, entries: -1 },
      { ...blocklist, fetchedAt: 'yesterday' },
      { url: blocklist.url, error: null, entries: 0 },
    ]) {
      expect(
        PluginCatalogOutputSchema.safeParse({ catalogs: [catalog], blocklist: bad }).success,
      ).toBe(false);
    }
    expect(
      PluginCatalogOutputSchema.safeParse({
        catalogs: [catalog],
        blocklist: {
          url: blocklist.url,
          error: 'blocklist signature missing',
          fetchedAt: null,
          entries: 0,
        },
      }).success,
    ).toBe(true);
    expect(Object.keys(PluginSummarySchema.shape)).toContain('blocked');
    const blocked = PluginSummarySchema.shape.blocked;
    expect(blocked.safeParse(null).success).toBe(true);
    expect(blocked.safeParse({ reason: 'Exfiltrates tokens', url: null }).success).toBe(true);
    expect(blocked.safeParse({ reason: 'x', url: 'https://example.com/a' }).success).toBe(true);
    expect(blocked.safeParse({ reason: 'x' }).success).toBe(false);
    expect(blocked.safeParse(undefined).success).toBe(false);
  });

  it('plugin provenance names the key that signed the install, or null', () => {
    const p = { sha256: 'a'.repeat(64), attestation: null, coreTested: [] };
    const shape = PluginDetailSchema.shape.provenance;
    expect(shape.safeParse(p).success).toBe(false);
    expect(shape.safeParse({ ...p, signedBy: null }).success).toBe(true);
    expect(shape.safeParse({ ...p, signedBy: 'k1' }).success).toBe(true);
  });

  it('remove needs confirm: true', () => {
    expect(PluginRemoveInputSchema.safeParse({ name: 'example', confirm: false }).success).toBe(
      false,
    );
    expect(PluginRemoveInputSchema.safeParse({ name: 'example', confirm: true }).success).toBe(
      true,
    );
  });

  it('parses a catalog with versions and a secret marker', () => {
    const v = {
      version: '1.0.0',
      sdk: '^1',
      compatible: true,
      coreTested: ['0.3.0'],
      sha256: 'a'.repeat(64),
      size: 10,
      attestation: null,
      signature: null,
      releasedAt: '2026-10-17',
      blocked: null,
    };
    expect(
      PluginCatalogOutputSchema.safeParse({
        catalogs: [
          {
            catalogUrl: 'https://example.com/c.json',
            official: false,
            signed: false,
            keyIds: [],
            error: null,
            plugins: [
              {
                name: 'example',
                title: 'E',
                description: 'd',
                latest: '1.0.0',
                installed: null,
                versions: [v],
                icon: null,
                nodes: [
                  { type: 'example:a', kind: 'finish', title: 'Notify' },
                  { type: 'example:b', kind: null, title: null },
                ],
              },
            ],
          },
        ],
        blocklist,
      }).success,
    ).toBe(true);
    expect(SecretMarkerSchema.safeParse({ set: true }).success).toBe(true);
    expect(SecretMarkerSchema.safeParse({ set: true, value: 'x' }).success).toBe(false);
    expect(SecretMarkerSchema.safeParse({ set: true, endsWith: '4f2a' }).success).toBe(true);
    expect(SecretMarkerSchema.safeParse({ set: true, endsWith: '4f2a5' }).success).toBe(false);
  });

  it('the list carries what each plugin is used by, its last connection test (no message) and the plugins workflows miss', () => {
    const summary = {
      name: 'example',
      version: '1.0.0',
      enabled: true,
      state: 'running',
      stateReason: null,
      nextRestartAt: null,
      blocked: null,
      nodes: ['example:a'],
      hasIntegration: true,
      updateAvailable: null,
      catalogUrl: null,
      installedAt: '2026-10-17T12:00:00.000Z',
      updatedAt: '2026-10-17T12:00:00.000Z',
      icon: null,
      usedBy: [{ id: 'w1', name: 'TV cleanup', active: true }],
      lastTest: { at: '2026-10-17T12:00:00.000Z', ok: false, kind: 'unreachable' },
    };
    const out = {
      plugins: [summary],
      missing: [{ name: 'sonarr', workflows: [{ id: 'w1', name: 'TV cleanup' }] }],
    };
    expect(PluginsListOutputSchema.safeParse(out).success).toBe(true);
    expect(PluginsListOutputSchema.safeParse({ plugins: [summary] }).success).toBe(false);
    expect(Object.keys(PluginSummarySchema.shape.lastTest.unwrap().shape)).toEqual([
      'at',
      'ok',
      'kind',
    ]);
  });
});

describe('licences', () => {
  // The fixture the licence generator's own tests produce: both sides agree on one format.
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../scripts/fixtures/licences/expected-third-party.json', import.meta.url),
      'utf8',
    ),
  );

  it('parses the generator fixture', () => {
    const parsed = ThirdPartyFileSchema.parse(fixture);
    expect(parsed.packages.length).toBeGreaterThan(0);
    for (const p of parsed.packages) expect(parsed.texts[p.textKey]).toBeTypeOf('string');
  });

  it('licences output is the file plus available, or available false alone', () => {
    expect(LicencesOutputSchema.parse({ ...fixture, available: true }).available).toBe(true);
    expect(LicencesOutputSchema.parse({ available: false })).toEqual({ available: false });
    expect(LicencesOutputSchema.safeParse({ available: true }).success).toBe(false);
  });

  it('rejects an unknown origin and another format', () => {
    const pkg = fixture.packages[0];
    expect(
      ThirdPartyFileSchema.safeParse({ ...fixture, packages: [{ ...pkg, origin: 'cdn' }] }).success,
    ).toBe(false);
    expect(ThirdPartyFileSchema.safeParse({ ...fixture, format: 2 }).success).toBe(false);
  });
});

describe('EncodeDeviceSchema', () => {
  it('accepts auto, cpu, nvidia:<n> and intel:<pci address>', () => {
    for (const v of ['auto', 'cpu', 'nvidia:0', 'intel:0000:07:00.0', 'intel:0000:0a:1f.7']) {
      expect(EncodeDeviceSchema.safeParse(v).success).toBe(true);
    }
  });
  it('rejects a short or out-of-range Intel address', () => {
    for (const v of ['intel:7:0.0', 'intel:0000:07:00.8', 'intel:0', 'intel:0000:07:00.0:x']) {
      expect(EncodeDeviceSchema.safeParse(v).success).toBe(false);
    }
  });
});
