import { oc } from '@orpc/contract';
import { authedErrors } from '../errors.ts';
import { NodesListOutputSchema } from '../schemas/nodes.ts';

export const nodes = {
  list: oc
    .route({ method: 'GET', path: '/nodes', tags: ['nodes'], summary: 'List available node types' })
    .errors(authedErrors)
    .output(NodesListOutputSchema),
};
