import { oc } from '@orpc/contract';
import { authedErrors } from '../errors.ts';
import { FsBrowseDirsInputSchema, FsBrowseDirsOutputSchema } from '../schemas/fs.ts';

const tags = ['fs'];

/**
 * Folder browsing for the library path picker: a person's browser session only (an API token is
 * refused whatever its scopes) and never offered over MCP.
 */
export const fs = {
  browseDirs: oc
    .route({
      method: 'GET',
      path: '/fs/dirs',
      tags,
      summary: 'List the readable sub-folders of a server folder (session only)',
    })
    .errors(authedErrors)
    .input(FsBrowseDirsInputSchema)
    .output(FsBrowseDirsOutputSchema),
};
