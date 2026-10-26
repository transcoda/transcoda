import { browseDirs as browse, hiddenRoots } from '../../fs/browse.ts';
import { os, requireHumanSessionWith } from '../middleware.ts';

// Listing the server's folders is a person's job: an API token never browses, whatever its scopes,
// and nothing here is offered over MCP.
const requireHumanSession = requireHumanSessionWith('Folder browsing is a UI action');

export const browseDirs = os.fs.browseDirs
  .use(requireHumanSession)
  .handler(async ({ context, input, errors }) => {
    const { config, installDir } = context.deps;
    const result = await browse(input.path, { hidden: hiddenRoots(config, installDir) });
    // One answer for hidden, missing, unreadable and not-a-folder: it says nothing about which.
    if (result === 'refused') throw errors.FORBIDDEN({ message: "This folder can't be opened" });
    return result;
  });
