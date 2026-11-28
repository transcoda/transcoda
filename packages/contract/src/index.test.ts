import { describe, expect, it } from 'vitest';
import { contract } from './index.ts';

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
      'status',
      'update',
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

  it('exposes the engine routers', () => {
    expect(Object.keys(contract.libraries)).toEqual([
      'list',
      'get',
      'browse',
      'create',
      'update',
      'dismissNotices',
      'delete',
      'titles',
      'seasons',
      'files',
      'file',
    ]);
    expect(contract.libraries.file['~orpc'].route).toMatchObject({
      method: 'GET',
      path: '/libraries/{id}/files/{fileId}',
    });
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
      'approve',
      'reject',
      'queueFiles',
      'queueFilesPreview',
    ]);
    expect(contract.jobs.queueFiles['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/jobs/queue-files',
    });
    expect(contract.jobs.queueFilesPreview['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/jobs/queue-files/preview',
    });
    expect(contract.jobs.cancelAll['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/jobs/cancel-all',
    });
    expect(contract.jobs.deleteTestOutput['~orpc'].route).toMatchObject({
      method: 'DELETE',
      path: '/jobs/{id}/test-output',
      description: "A person's session only.",
    });
    expect(contract.jobs.approve['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/jobs/{id}/approve',
    });
    expect(contract.jobs.reject['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/jobs/{id}/reject',
    });
    expect(Object.keys(contract.queue)).toEqual(['status', 'pause', 'resume']);
    expect(Object.keys(contract.runs)).toEqual(['list', 'get', 'processAgain']);
    expect(contract.runs.processAgain['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/runs/{id}/process-again',
    });
    expect(contract.runs.processAgain['~orpc'].route.description).toMatch(
      /^A person's session only\./,
    );
    expect(Object.keys(contract.events)).toEqual(['subscribe']);
  });
});
