import { PluginServiceError } from '../../plugins/errors.ts';
import { os, requireHumanSessionWith, requireScope } from '../middleware.ts';

const requireHumanSession = requireHumanSessionWith('Plugin management is a UI action');

// Plugin management is a person's job: an API token never installs, changes, removes, enables or
// disables a plugin, reads its settings or sees the catalog, whatever its scopes. Only `list`
// (names, versions, states, node types, the workflows using them and whether the last connection
// test passed; never settings or a test message) is open to a `read` token.

interface PluginErrors {
  NOT_FOUND: (o?: { message?: string }) => Error;
  PLUGIN_INSTALL_FAILED: (o: { data: { reason: string } }) => Error;
  PLUGIN_SETTINGS_INVALID: (o: {
    data: { issues: Array<{ path: string; message: string; missing: boolean }> };
  }) => Error;
  PLUGIN_NOT_RUNNING: (o: { data: { reason: string } }) => Error;
}

/**
 * Maps the service's error codes onto the contract's. Each procedure only declares the codes it
 * can raise; the proxy of one that does not declare a code is never asked for it.
 */
function mapped(err: unknown, errors: Partial<PluginErrors>): never {
  if (err instanceof PluginServiceError) {
    switch (err.code) {
      case 'not-found':
      case 'no-integration':
        if (errors.NOT_FOUND) throw errors.NOT_FOUND({ message: err.message });
        break;
      case 'not-running':
        if (errors.PLUGIN_NOT_RUNNING) {
          throw errors.PLUGIN_NOT_RUNNING({ data: { reason: err.message } });
        }
        break;
      case 'settings-invalid':
        if (errors.PLUGIN_SETTINGS_INVALID) {
          throw errors.PLUGIN_SETTINGS_INVALID({ data: { issues: err.issues } });
        }
        break;
      case 'invalid':
        if (errors.PLUGIN_INSTALL_FAILED) {
          throw errors.PLUGIN_INSTALL_FAILED({ data: { reason: err.message } });
        }
        break;
    }
  }
  throw err;
}

export const list = os.plugins.list
  .use(requireScope('read'))
  .handler(({ context }) => context.deps.plugins.listing());

export const catalog = os.plugins.catalog
  .use(requireHumanSession)
  .handler(({ context, input }) => context.deps.plugins.catalog(input.refresh));

export const catalogsAdd = os.plugins.catalogsAdd
  .use(requireHumanSession)
  .handler(async ({ context, input, errors }) => {
    try {
      context.deps.plugins.addCatalog(input.url, input.signingKeys);
    } catch (err) {
      mapped(err, errors);
    }
    return context.deps.plugins.catalog(false);
  });

export const catalogsRemove = os.plugins.catalogsRemove
  .use(requireHumanSession)
  .handler(async ({ context, input, errors }) => {
    try {
      context.deps.plugins.removeCatalog(input.url);
    } catch (err) {
      mapped(err, errors);
    }
    return context.deps.plugins.catalog(false);
  });

export const get = os.plugins.get.use(requireHumanSession).handler(({ context, input, errors }) => {
  const detail = context.deps.plugins.get(input.name);
  if (!detail) throw errors.NOT_FOUND();
  return detail;
});

export const install = os.plugins.install
  .use(requireHumanSession)
  .handler(async ({ context, input, errors }) => {
    try {
      const r = await context.deps.plugins.install(input);
      if (!r.ok) throw errors.PLUGIN_INSTALL_FAILED({ data: { reason: r.reason } });
      return r.plugin;
    } catch (err) {
      return mapped(err, errors);
    }
  });

export const update = os.plugins.update
  .use(requireHumanSession)
  .handler(async ({ context, input, errors }) => {
    try {
      const r = await context.deps.plugins.update(input.name, input.version);
      if (!r.ok) throw errors.PLUGIN_INSTALL_FAILED({ data: { reason: r.reason } });
      return r.plugin;
    } catch (err) {
      return mapped(err, errors);
    }
  });

export const updateCheck = os.plugins.updateCheck
  .use(requireHumanSession)
  .handler(async ({ context, input, errors }) => {
    try {
      const r = await context.deps.plugins.updateCheck(input.name, input.version);
      if (!r.ok) throw errors.PLUGIN_INSTALL_FAILED({ data: { reason: r.reason } });
      return { wouldBreak: r.wouldBreak, needsReview: r.needsReview, unknown: r.unknown };
    } catch (err) {
      return mapped(err, errors);
    }
  });

export const remove = os.plugins.remove
  .use(requireHumanSession)
  .handler(async ({ context, input, errors }) => {
    try {
      await context.deps.plugins.remove(input.name);
    } catch (err) {
      mapped(err, errors);
    }
    return { ok: true as const };
  });

export const enable = os.plugins.enable
  .use(requireHumanSession)
  .handler(async ({ context, input, errors }) => {
    try {
      return await context.deps.plugins.enable(input.name);
    } catch (err) {
      return mapped(err, errors);
    }
  });

export const disable = os.plugins.disable
  .use(requireHumanSession)
  .handler(async ({ context, input, errors }) => {
    try {
      return await context.deps.plugins.disable(input.name);
    } catch (err) {
      return mapped(err, errors);
    }
  });

export const restart = os.plugins.restart
  .use(requireHumanSession)
  .handler(async ({ context, input, errors }) => {
    try {
      return await context.deps.plugins.restart(input.name);
    } catch (err) {
      return mapped(err, errors);
    }
  });

export const settingsGet = os.plugins.settingsGet
  .use(requireHumanSession)
  .handler(({ context, input, errors }) => {
    try {
      return context.deps.plugins.getSettings(input.name);
    } catch (err) {
      return mapped(err, errors);
    }
  });

export const settingsSave = os.plugins.settingsSave
  .use(requireHumanSession)
  .handler(async ({ context, input, errors }) => {
    try {
      return await context.deps.plugins.saveSettings(input.name, input.settings);
    } catch (err) {
      return mapped(err, errors);
    }
  });

export const settingsTest = os.plugins.settingsTest
  .use(requireHumanSession)
  .handler(async ({ context, input, errors }) => {
    try {
      return await context.deps.plugins.testSettings(input.name, input.settings);
    } catch (err) {
      return mapped(err, errors);
    }
  });

export const testMapping = os.plugins.testMapping
  .use(requireHumanSession)
  .handler(({ context, input, errors }) => {
    try {
      return context.deps.plugins.testMapping(input.name, input.mapping);
    } catch (err) {
      return mapped(err, errors);
    }
  });
