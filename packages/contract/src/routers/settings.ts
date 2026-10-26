import { oc } from '@orpc/contract';
import { authedErrors, mutationErrors } from '../errors.ts';
import { SettingsSchema, SettingsUpdateInputSchema } from '../schemas/settings.ts';

export const settings = {
  get: oc
    .route({
      method: 'GET',
      path: '/settings',
      tags: ['settings'],
      summary: 'Server settings and where each value comes from',
    })
    .errors(authedErrors)
    .output(SettingsSchema),
  /** A person's browser session only: any API token is refused (FORBIDDEN), never an MCP tool. */
  update: oc
    .route({
      method: 'PATCH',
      path: '/settings',
      tags: ['settings'],
      summary: 'Change server settings (session only)',
    })
    .errors(mutationErrors)
    .input(SettingsUpdateInputSchema)
    .output(SettingsSchema),
};
