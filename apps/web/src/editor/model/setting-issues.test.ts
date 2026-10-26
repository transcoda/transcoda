import type { Issue } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { nodeStateFor } from './issues.ts';
import { fieldsFor } from './schema-fields.ts';
import { effectiveNodeIssues, jsonEquals } from './setting-issues.ts';

const webhook = catalogFixture.byType.get('core:notify-webhook');
if (!webhook) throw new Error('fixture');
const fields = fieldsFor(webhook.settingsSchema);

const needs: Issue = {
  severity: 'error',
  code: 'INVALID_SETTINGS',
  message: 'Needs a setting',
  nodeId: 'n',
  settingPath: 'url',
};
const unconnected: Issue = {
  severity: 'error',
  code: 'INPUT_UNCONNECTED',
  message: 'Input file is not connected',
  nodeId: 'n',
};

describe('effectiveNodeIssues', () => {
  it('a client issue takes the place of the server message, so the state matches the card', () => {
    const out = effectiveNodeIssues('n', fields, {}, {}, [needs, unconnected]);
    expect(out.map((i) => i.code)).toEqual(['INVALID_SETTINGS', 'INPUT_UNCONNECTED']);
    expect(nodeStateFor('n', out).word).toBe('needs a setting');
  });

  it('a server message for a changed value is dropped; for the validated value it stays', () => {
    const bad: Issue = { ...needs, message: 'Invalid URL' };
    const url = { url: 'http://a' };
    expect(effectiveNodeIssues('n', fields, url, url, [bad])).toEqual([bad]);
    expect(effectiveNodeIssues('n', fields, { url: 'http://b' }, url, [bad])).toEqual([]);
  });

  it('without fields the server issues stay as they are', () => {
    expect(effectiveNodeIssues('n', null, null, null, [needs, unconnected])).toEqual([
      needs,
      unconnected,
    ]);
  });

  it('jsonEquals ignores key order', () => {
    expect(jsonEquals({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEquals([1], [1, 2])).toBe(false);
  });
});
