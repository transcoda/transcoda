// Prints the core node catalogue for the web test fixture:
//   pnpm --filter @transcoda/server dump-nodes > apps/web/src/test/fixtures/nodes.json
// then re-add the hand-written `test:unavailable` entry (see apps/web/src/test/fixtures/catalog.ts).
import { fixtureNodes } from '../src/nodes/web-fixture.ts';

process.stdout.write(`${JSON.stringify({ nodes: fixtureNodes() }, null, 2)}\n`);
