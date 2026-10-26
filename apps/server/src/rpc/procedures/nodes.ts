import { os, requireScope } from '../middleware.ts';

export const list = os.nodes.list
  .use(requireScope('read'))
  .handler(({ context }) => ({ nodes: context.deps.workflows.listNodes() }));
