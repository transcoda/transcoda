import { describe, expect, it } from 'vitest';
import { get, json, useRpcApp } from './testing.ts';

useRpcApp();

describe('system', () => {
  it('system.capabilities lists deviceProfiles with names', async () => {
    const res = await get('/system/capabilities');
    expect(res.status).toBe(200);
    const body = await json<{ deviceProfiles: { id: string; name: string }[] }>(res);
    expect(body).toMatchObject({ available: true, version: '9.0.2' });
    expect(body.deviceProfiles).toEqual([
      { id: 'android-tv', name: 'Android TV (Google TV / Shield class)' },
      { id: 'chrome', name: 'Chrome (desktop)' },
    ]);
  });
});
