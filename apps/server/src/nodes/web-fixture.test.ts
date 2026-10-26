import { readFileSync } from 'node:fs';
import type { NodeInfo } from '@transcoda/contract';
import { describe, expect, it } from 'vitest';
import { fixtureNodes } from './web-fixture.ts';

describe('web node-catalogue fixture', () => {
  it('apps/web/src/test/fixtures/nodes.json matches the live core catalogue', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../../../web/src/test/fixtures/nodes.json', import.meta.url), 'utf8'),
    ) as { nodes: NodeInfo[] };
    expect(
      fixture.nodes.filter((n) => n.type.startsWith('core:')),
      'run pnpm --filter @transcoda/server dump-nodes',
    ).toEqual(fixtureNodes());
  });

  it('carries finishPhase like nodes.list: the phase for a finish node, null otherwise', () => {
    const nodes = fixtureNodes();
    expect(nodes.find((n) => n.type === 'core:replace-original')?.finishPhase).toBe('write');
    expect(nodes.find((n) => n.type === 'core:video-is')?.finishPhase).toBeNull();
  });
});
