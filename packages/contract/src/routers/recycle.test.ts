import { describe, expect, it } from 'vitest';
import { contract } from '../index.ts';

describe('recycle router', () => {
  it('exposes the recycle router', () => {
    expect(Object.keys(contract.recycle)).toEqual(['restore', 'list', 'delete', 'empty']);
    expect(contract.recycle.restore['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/recycle/restore',
    });
    expect(contract.recycle.list['~orpc'].route).toMatchObject({ method: 'GET', path: '/recycle' });
    for (const [key, path] of [
      ['delete', '/recycle/delete'],
      ['empty', '/recycle/empty'],
    ] as const) {
      expect(contract.recycle[key]['~orpc'].route).toMatchObject({ method: 'POST', path });
      expect(contract.recycle[key]['~orpc'].route.description).toMatch(
        /^A person's session only\./,
      );
    }
    expect(contract.recycle.restore['~orpc'].route.description).toMatch(
      /^A person's session only\./,
    );
  });
});
