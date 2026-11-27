import { describe, expect, it } from 'vitest';
import {
  assertIsolationUsable,
  capsFromStatus,
  IsolationError,
  isolationViolation,
  processIdentity,
  REQUIRED_CAPS,
} from './isolation.ts';

const iso = {
  uid: 65001,
  gid: 65001,
  runDir: '/run/transcoda/plugins',
  setprivPath: '/usr/bin/setpriv',
};

const STATUS = [
  'Name:\tnode',
  'Uid:\t65001\t65001\t65001\t65001',
  'Gid:\t65002\t65002\t65002\t65002',
  'CapInh:\t0000000000000000',
  'CapPrm:\t00000000000000e0',
  'CapEff:\t00000000000000e0',
  'CapBnd:\t00000000000000e0',
  'CapAmb:\t0000000000000000',
  'NoNewPrivs:\t1',
  '',
].join('\n');

type Fs = NonNullable<Parameters<typeof assertIsolationUsable>[1]>;

function fakeFs(over: {
  status?: string;
  setpriv?: boolean;
  runDir?: 'ok' | 'missing' | 'file' | 'readonly';
}): Fs {
  const o = { status: STATUS, setpriv: true, runDir: 'ok', ...over };
  const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  return {
    readFile: async () => o.status,
    access: async (path: string) => {
      if (path === iso.setprivPath) {
        if (!o.setpriv) throw enoent;
        return;
      }
      if (o.runDir === 'missing') throw enoent;
      if (o.runDir === 'readonly') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
    stat: async () => {
      if (o.runDir === 'missing') throw enoent;
      return { isDirectory: () => o.runDir !== 'file' };
    },
  } as unknown as Fs;
}

describe('capsFromStatus', () => {
  it('reads one capability field as a bigint', () => {
    expect(capsFromStatus(STATUS, 'CapEff')).toBe(0xe0n);
    expect(capsFromStatus(STATUS, 'CapAmb')).toBe(0n);
    expect(capsFromStatus('', 'CapPrm')).toBe(0n);
    expect(REQUIRED_CAPS).toBe(0xe0n);
  });
});

describe('assertIsolationUsable', () => {
  it('passes with the capabilities, setpriv and a writable run dir', async () => {
    await expect(assertIsolationUsable(iso, fakeFs({}))).resolves.toBeUndefined();
  });

  it('names the missing capabilities', async () => {
    const status = STATUS.replace('CapEff:\t00000000000000e0', 'CapEff:\t0000000000000060');
    const err = await assertIsolationUsable(iso, fakeFs({ status })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IsolationError);
    expect((err as Error).message).toBe(
      "plugin isolation needs CAP_SETUID, CAP_SETGID and CAP_KILL; start the container as root with the compose file's cap_add list",
    );
  });

  it('names a missing setpriv', async () => {
    await expect(assertIsolationUsable(iso, fakeFs({ setpriv: false }))).rejects.toThrow(
      'plugin isolation: setpriv not found at /usr/bin/setpriv',
    );
  });

  it.each(['missing', 'file', 'readonly'] as const)(
    'names an unusable run dir (%s)',
    async (runDir) => {
      await expect(assertIsolationUsable(iso, fakeFs({ runDir }))).rejects.toThrow(
        'plugin isolation: /run/transcoda/plugins is not a writable directory (mount a tmpfs at /run/transcoda)',
      );
    },
  );
});

describe('processIdentity', () => {
  it('parses a status sample into ids and capability strings', async () => {
    const read = async () => STATUS;
    expect(await processIdentity(123, { platform: 'linux', readFile: read })).toEqual({
      uid: 65001,
      gid: 65002,
      capEff: '00000000000000e0',
      capPrm: '00000000000000e0',
      capAmb: '0000000000000000',
      noNewPrivs: 1,
    });
  });

  it('is null off Linux, for an unknown pid and for no pid', async () => {
    expect(
      await processIdentity(1, { platform: 'darwin', readFile: async () => STATUS }),
    ).toBeNull();
    expect(
      await processIdentity(1, {
        platform: 'linux',
        readFile: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBeNull();
    expect(
      await processIdentity(undefined, { platform: 'linux', readFile: async () => STATUS }),
    ).toBeNull();
  });
});

describe('isolationViolation', () => {
  const good = {
    uid: 65001,
    gid: 65001,
    capEff: '0000000000000000',
    capPrm: '0000000000000000',
    capAmb: '0000000000000000',
    noNewPrivs: 1,
  };
  it('is null for the expected identity and names the first wrong field otherwise', () => {
    expect(isolationViolation(good, iso)).toBeNull();
    expect(isolationViolation({ ...good, uid: 0, gid: 5 }, iso)).toBe('uid expected 65001, got 0');
    expect(isolationViolation({ ...good, capAmb: '00000000000000e0' }, iso)).toBe(
      'capAmb expected 0000000000000000, got 00000000000000e0',
    );
    expect(isolationViolation({ ...good, capEff: '' }, iso)).toBe(
      'capEff expected 0000000000000000, got ',
    );
    expect(isolationViolation({ ...good, noNewPrivs: 0 }, iso)).toBe(
      'noNewPrivs expected 1, got 0',
    );
    expect(isolationViolation(null, iso)).toBe('identity expected readable, got unreadable');
  });
  it('compares capability masks by value, not spelling', () => {
    expect(isolationViolation({ ...good, capEff: '0' }, iso)).toBeNull();
    expect(isolationViolation({ ...good, capEff: '000000000000000000' }, iso)).toBeNull();
  });
});
