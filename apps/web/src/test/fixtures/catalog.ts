import { type NodeInfo, NodesListOutputSchema } from '@transcoda/contract';
import { buildCatalog } from '../../hooks/useCatalog.ts';
import raw from './nodes.json';

/**
 * The core catalogue from `pnpm --filter @transcoda/server dump-nodes` plus one hand-written
 * entry, `test:unavailable` (a plugin node whose availability is false). Web tests use these,
 * never the raw JSON.
 */
export const nodesFixture: NodeInfo[] = NodesListOutputSchema.parse(raw).nodes;
export const catalogFixture = buildCatalog(nodesFixture);
