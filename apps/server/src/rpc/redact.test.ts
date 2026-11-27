import { describe, expect, it } from 'vitest';
import { chain, node } from '../workflows/test-helpers.ts';
import { SECRET } from './procedures/testing.ts';
import { redactGraph } from './redact.ts';

describe('redactGraph', () => {
  it('shows webhook URLs in notify settings and Run-node overrides as scheme and host only', () => {
    const graph = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('run', 'core:run-subworkflow', {
        subworkflowId: 'sub',
        version: 1,
        overrides: {
          'nw.url': `https://hooks.example/${SECRET}`,
          'nw.method': 'PUT',
          'other.endpoint': `http://10.0.0.5:8080/${SECRET}?k=${SECRET}`,
          'other.note': 'ftp-ish text, not a URL',
          'other.count': 3,
        },
      }),
      node('nw', 'core:notify-webhook', { url: `https://hooks.example/${SECRET}` }),
    );
    const out = redactGraph(graph);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.nodes[1]?.settings).toEqual({
      subworkflowId: 'sub',
      version: 1,
      overrides: {
        'nw.url': 'https://hooks.example/…',
        'nw.method': 'PUT',
        'other.endpoint': 'http://10.0.0.5:8080/…',
        'other.note': 'ftp-ish text, not a URL',
        'other.count': 3,
      },
    });
    expect(out.nodes[2]?.settings).toMatchObject({ url: 'https://hooks.example/…' });
    expect(out.edges).toEqual(graph.edges);
  });
});
