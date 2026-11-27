// docs/mcp.md lists the tools by hand. This test keeps its Tools table in step with ALL_TOOLS (which
// never.test.ts pins to EXPECTED_TOOLS): every tool has a row, in no other, with the scopes it needs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from './tools/index.ts';

const DOCS = readFileSync(
  fileURLToPath(new URL('../../../../docs/mcp.md', import.meta.url)),
  'utf8',
);

/** The Tools table's rows as tool name → the scopes its Scope cell names. */
function toolRows(): Map<string, string[]> {
  const start = DOCS.indexOf('\n## Tools\n');
  const end = DOCS.indexOf('\n## ', start + 1);
  const rows = new Map<string, string[]>();
  for (const line of DOCS.slice(start, end).split('\n')) {
    const m = /^\| `([a-z_]+)` \| ([^|]+) \|/.exec(line);
    if (m?.[1] && m[2])
      rows.set(
        m[1],
        [...m[2].matchAll(/`([^`]+)`/g)].map((s) => s[1] ?? ''),
      );
  }
  return rows;
}

describe('docs/mcp.md', () => {
  const rows = toolRows();

  it('has a row for every tool, and no other', () => {
    expect([...rows.keys()].sort()).toEqual(ALL_TOOLS.map((tool) => tool.name).sort());
  });

  it('gives the number of tools', () => {
    expect(DOCS).toContain(`\n${ALL_TOOLS.length} tools.`);
  });

  it('names the scopes each tool needs', () => {
    for (const tool of ALL_TOOLS) {
      expect(rows.get(tool.name)?.sort(), tool.name).toEqual([...tool.scopes].sort());
    }
  });
});
