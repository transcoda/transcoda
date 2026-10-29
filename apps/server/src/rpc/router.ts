import { os } from './middleware.ts';
import * as auth from './procedures/auth.ts';
import * as events from './procedures/events.ts';
import * as fs from './procedures/fs.ts';
import * as jobs from './procedures/jobs.ts';
import * as libraries from './procedures/libraries.ts';
import * as nodes from './procedures/nodes.ts';
import * as plugins from './procedures/plugins.ts';
import * as queue from './procedures/queue.ts';
import * as runs from './procedures/runs.ts';
import * as settings from './procedures/settings.ts';
import * as system from './procedures/system.ts';
import * as tokens from './procedures/tokens.ts';
import * as workflows from './procedures/workflows.ts';

export function createRouter() {
  return os.router({
    system: {
      health: system.health,
      capabilities: system.capabilities,
      gpuLoad: system.gpuLoad,
      update: system.update,
      licences: system.licences,
      backups: {
        list: system.backupsList,
        create: system.backupsCreate,
      },
    },
    settings: {
      get: settings.get,
      update: settings.update,
    },
    auth: {
      setup: auth.setup,
      login: auth.login,
      logout: auth.logout,
      me: auth.me,
      changePassword: auth.changePassword,
    },
    tokens: {
      create: tokens.create,
      list: tokens.list,
      revoke: tokens.revoke,
    },
    nodes: {
      list: nodes.list,
    },
    workflows: {
      list: workflows.list,
      get: workflows.get,
      create: workflows.create,
      save: workflows.save,
      validate: workflows.validate,
      activate: workflows.activate,
      deactivate: workflows.deactivate,
      rename: workflows.rename,
      delete: workflows.remove,
      versions: workflows.versions,
      duplicate: workflows.duplicate,
    },
    libraries: {
      list: libraries.list,
      get: libraries.get,
      browse: libraries.browse,
      create: libraries.create,
      update: libraries.update,
      dismissNotices: libraries.dismissNotices,
      delete: libraries.remove,
    },
    jobs: {
      queue: jobs.queue,
      list: jobs.list,
      stats: jobs.stats,
      history: jobs.history,
      get: jobs.get,
      log: jobs.log,
      pause: jobs.pause,
      resume: jobs.resume,
      cancel: jobs.cancel,
      cancelAll: jobs.cancelAll,
      retryFailed: jobs.retryFailed,
      deleteTestOutput: jobs.deleteTestOutput,
    },
    queue: {
      status: queue.get,
      pause: queue.pause,
      resume: queue.resume,
    },
    runs: {
      list: runs.list,
      get: runs.get,
    },
    events: {
      subscribe: events.subscribe,
    },
    fs: {
      browseDirs: fs.browseDirs,
    },
    plugins: {
      list: plugins.list,
      catalog: plugins.catalog,
      catalogsAdd: plugins.catalogsAdd,
      catalogsRemove: plugins.catalogsRemove,
      get: plugins.get,
      install: plugins.install,
      update: plugins.update,
      updateCheck: plugins.updateCheck,
      remove: plugins.remove,
      enable: plugins.enable,
      disable: plugins.disable,
      restart: plugins.restart,
      settingsGet: plugins.settingsGet,
      settingsSave: plugins.settingsSave,
      settingsTest: plugins.settingsTest,
      testMapping: plugins.testMapping,
    },
  });
}

export type Router = ReturnType<typeof createRouter>;
