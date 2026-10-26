import { readSettings, updateSettings } from '../../settings/service.ts';
import { os, requireHumanSessionWith, requireScope } from '../middleware.ts';

// Changing a setting is a person's job: an API token never updates one, whatever its scopes, and
// nothing here is offered over MCP. Reading needs the `read` scope (a session has every scope).
const requireHumanSession = requireHumanSessionWith('Settings are changed in the UI');

export const get = os.settings.get
  .use(requireScope('read'))
  .handler(({ context }) => readSettings(context.deps.settings));

export const update = os.settings.update
  .use(requireHumanSession)
  .handler(({ input, context }) => updateSettings(context.deps.settings, input));
