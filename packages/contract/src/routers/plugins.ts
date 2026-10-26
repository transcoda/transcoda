import { oc } from '@orpc/contract';
import { authedErrors, mutationErrors, pickErrors } from '../errors.ts';
import { OkOutputSchema } from '../schemas/auth.ts';
import {
  PathMappingTestInputSchema,
  PathMappingTestOutputSchema,
  PluginCatalogAddInputSchema,
  PluginCatalogInputSchema,
  PluginCatalogOutputSchema,
  PluginDetailSchema,
  PluginInstallInputSchema,
  PluginNameInputSchema,
  PluginRemoveInputSchema,
  PluginSettingsGetOutputSchema,
  PluginSettingsSaveInputSchema,
  PluginSettingsTestInputSchema,
  PluginsListOutputSchema,
  PluginTestOutputSchema,
  PluginUpdateCheckOutputSchema,
  PluginUpdateInputSchema,
} from '../schemas/plugins.ts';

const tags = ['plugins'];

/**
 * Plugin management is a person's job: every procedure except `list` is for the browser session
 * only (an API token is refused whatever its scopes). Settings carry secrets, so nothing here is
 * ever offered to a token or to MCP.
 */
export const plugins = {
  list: oc
    .route({
      method: 'GET',
      path: '/plugins',
      tags,
      summary: 'List installed plugins and whether they run',
    })
    .errors(authedErrors)
    .output(PluginsListOutputSchema),
  // Static routes (`/plugins/catalog`, `/plugins/catalogs`) are matched before `/plugins/{name}`.
  catalog: oc
    .route({
      method: 'GET',
      path: '/plugins/catalog',
      tags,
      summary: 'The plugin catalogs and their versions (session only)',
    })
    .errors(authedErrors)
    .input(PluginCatalogInputSchema)
    .output(PluginCatalogOutputSchema),
  catalogsAdd: oc
    .route({
      method: 'POST',
      path: '/plugins/catalogs',
      tags,
      summary: 'Add a plugin catalog (session only)',
    })
    .errors({ ...mutationErrors, ...pickErrors('PLUGIN_INSTALL_FAILED') })
    .input(PluginCatalogAddInputSchema)
    .output(PluginCatalogOutputSchema),
  catalogsRemove: oc
    .route({
      method: 'DELETE',
      path: '/plugins/catalogs',
      tags,
      summary: 'Remove a plugin catalog (session only)',
    })
    .errors({ ...mutationErrors, ...pickErrors('PLUGIN_INSTALL_FAILED') })
    .input(PluginCatalogAddInputSchema)
    .output(PluginCatalogOutputSchema),
  get: oc
    .route({
      method: 'GET',
      path: '/plugins/{name}',
      tags,
      summary: 'A plugin in detail (session only)',
    })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND') })
    .input(PluginNameInputSchema)
    .output(PluginDetailSchema),
  install: oc
    .route({ method: 'POST', path: '/plugins', tags, summary: 'Install a plugin (session only)' })
    .errors({ ...mutationErrors, ...pickErrors('PLUGIN_INSTALL_FAILED', 'NOT_FOUND') })
    .input(PluginInstallInputSchema)
    .output(PluginDetailSchema),
  update: oc
    .route({
      method: 'POST',
      path: '/plugins/{name}/update',
      tags,
      summary: 'Update a plugin to another version (session only)',
    })
    .errors({ ...mutationErrors, ...pickErrors('PLUGIN_INSTALL_FAILED', 'NOT_FOUND') })
    .input(PluginUpdateInputSchema)
    .output(PluginDetailSchema),
  updateCheck: oc
    .route({
      method: 'POST',
      path: '/plugins/{name}/update-check',
      tags,
      summary: 'Which workflows an update would affect (session only)',
    })
    .errors({ ...mutationErrors, ...pickErrors('PLUGIN_INSTALL_FAILED', 'NOT_FOUND') })
    .input(PluginUpdateInputSchema)
    .output(PluginUpdateCheckOutputSchema),
  remove: oc
    .route({
      method: 'DELETE',
      path: '/plugins/{name}',
      tags,
      summary: 'Remove a plugin (session only)',
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND', 'PLUGIN_INSTALL_FAILED') })
    .input(PluginRemoveInputSchema)
    .output(OkOutputSchema),
  enable: oc
    .route({
      method: 'POST',
      path: '/plugins/{name}/enable',
      tags,
      summary: 'Enable a plugin (session only)',
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND') })
    .input(PluginNameInputSchema)
    .output(PluginDetailSchema),
  disable: oc
    .route({
      method: 'POST',
      path: '/plugins/{name}/disable',
      tags,
      summary: 'Disable a plugin (session only)',
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND') })
    .input(PluginNameInputSchema)
    .output(PluginDetailSchema),
  restart: oc
    .route({
      method: 'POST',
      path: '/plugins/{name}/restart',
      tags,
      summary: 'Restart a plugin process (session only)',
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND', 'PLUGIN_NOT_RUNNING') })
    .input(PluginNameInputSchema)
    .output(PluginDetailSchema),
  settingsGet: oc
    .route({
      method: 'GET',
      path: '/plugins/{name}/settings',
      tags,
      summary: "A plugin's integration settings, secrets masked (session only)",
    })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND') })
    .input(PluginNameInputSchema)
    .output(PluginSettingsGetOutputSchema),
  settingsSave: oc
    .route({
      method: 'PUT',
      path: '/plugins/{name}/settings',
      tags,
      summary: "Save a plugin's integration settings (session only)",
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND', 'PLUGIN_SETTINGS_INVALID') })
    .input(PluginSettingsSaveInputSchema)
    .output(PluginSettingsGetOutputSchema),
  settingsTest: oc
    .route({
      method: 'POST',
      path: '/plugins/{name}/settings/test',
      tags,
      summary: 'Test integration settings without saving them (session only)',
    })
    .errors({
      ...mutationErrors,
      ...pickErrors('NOT_FOUND', 'PLUGIN_SETTINGS_INVALID', 'PLUGIN_NOT_RUNNING'),
    })
    .input(PluginSettingsTestInputSchema)
    .output(PluginTestOutputSchema),
  testMapping: oc
    .route({
      method: 'POST',
      path: '/plugins/{name}/settings/test-mapping',
      tags,
      summary: 'Check a path mapping against the library roots (session only)',
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND') })
    .input(PathMappingTestInputSchema)
    .output(PathMappingTestOutputSchema),
};
