import { defineNode, definePlugin } from '@transcoda/sdk';
import { z } from 'zod';

const spinNode = defineNode({
  type: 'spin:spin',
  version: 1,
  kind: 'data',
  title: 'Spin',
  description: 'Never returns: a busy loop, for the supervisor timeout tests.',
  icon: 'loop',
  inputs: [],
  outputs: [{ id: 'value', label: 'Value', type: 'data:spin' }],
  settings: z.object({}),
  async data() {
    for (;;) {}
  },
});

export default definePlugin({ name: 'spin', version: '0.1.0', sdk: '^1', nodes: [spinNode] });
