import { describe, expect, it } from 'vitest';
import { IntelLoadReader, type ProcFs, parseDrmFdinfo } from './intel-load.ts';

const fdinfo = (client: string, videoNs: number, capacity = 2, pdev = '0000:07:00.0') =>
  `drm-driver:\ti915\ndrm-pdev:\t${pdev}\ndrm-client-id:\t${client}\n` +
  `drm-engine-render:\t0 ns\ndrm-engine-video:\t${videoNs} ns\ndrm-engine-capacity-video:\t${capacity}\n`;

describe('parseDrmFdinfo', () => {
  it('reads the PCI address, client and video engine', () => {
    expect(parseDrmFdinfo(fdinfo('42', 1_000_000_000))).toEqual({
      pdev: '0000:07:00.0',
      clientId: '42',
      videoNs: 1_000_000_000,
      videoCapacity: 2,
    });
  });

  it('defaults the capacity to 1 and returns null without a video engine line', () => {
    const noCap = 'drm-pdev:\t0000:07:00.0\ndrm-client-id:\t1\ndrm-engine-video:\t5 ns\n';
    expect(parseDrmFdinfo(noCap)?.videoCapacity).toBe(1);
    expect(parseDrmFdinfo('drm-pdev:\t0000:07:00.0\ndrm-client-id:\t1\n')).toBeNull();
  });
});

/** A fake /proc: `fds` maps `pid/fd` to its link and fdinfo text. */
function fakeProc(fds: Record<string, { link: string; info: string }>): ProcFs {
  const gone = () => {
    throw new Error('EACCES');
  };
  return {
    readdir: (p) => {
      if (p === '/proc')
        return [...new Set(Object.keys(fds).map((k) => k.split('/')[0] as string)), 'self', '999'];
      const m = /^\/proc\/(\d+)\/fd$/.exec(p);
      if (!m) return gone();
      return Object.keys(fds)
        .filter((k) => k.startsWith(`${m[1]}/`))
        .map((k) => k.split('/')[1] as string);
    },
    readlink: (p) => fds[p.replace('/proc/', '').replace('/fd/', '/')]?.link ?? gone(),
    readFile: (p) => fds[p.replace('/proc/', '').replace('/fdinfo/', '/')]?.info ?? gone(),
  };
}

describe('IntelLoadReader', () => {
  const pci = '0000:07:00.0';
  const render = '/dev/dri/renderD128';

  it('turns the busy-time change of a client into a percentage of the video engines', () => {
    let t = 0;
    let ns = 1e9;
    const proc = (): ProcFs => fakeProc({ '10/3': { link: render, info: fdinfo('42', ns) } });
    const reader = new IntelLoadReader({
      proc: { ...proc(), readFile: (p) => proc().readFile(p) },
      now: () => t,
    });
    expect(reader.sample([pci]).get(pci)).toBe(0);
    t = 5000;
    ns = 6e9;
    expect(reader.sample([pci]).get(pci)).toBe(50);
  });

  it('counts two fds of the same client once', () => {
    let t = 0;
    let ns = 0;
    const reader = new IntelLoadReader({
      proc: {
        readdir: (p) => (p === '/proc' ? ['10'] : ['3', '4']),
        readlink: () => render,
        readFile: () => fdinfo('42', ns),
      },
      now: () => t,
    });
    reader.sample([pci]);
    t = 5000;
    ns = 5e9;
    expect(reader.sample([pci]).get(pci)).toBe(50);
  });

  it('reads 0 for a first-seen client, skips unreadable entries and other cards, and caps at 100', () => {
    let t = 0;
    let ns = 0;
    const reader = new IntelLoadReader({
      proc: fakeProc({
        '10/3': { link: render, info: fdinfo('1', 0) },
        '11/3': { link: '/dev/null', info: '' },
      }),
      now: () => t,
    });
    expect(reader.sample([pci, '0000:08:00.0'])).toEqual(new Map([[pci, 0]]));

    const hot = new IntelLoadReader({
      proc: {
        readdir: (p) => (p === '/proc' ? ['10'] : ['3']),
        readlink: () => render,
        readFile: () => fdinfo('1', ns, 1),
      },
      now: () => t,
    });
    hot.sample([pci]);
    t = 5000;
    ns = 50e9;
    expect(hot.sample([pci]).get(pci)).toBe(100);
  });

  it('drops a client that is gone, so a returning client starts from a new baseline', () => {
    let t = 0;
    let present = true;
    let ns = 0;
    const reader = new IntelLoadReader({
      proc: {
        readdir: (p) => (p === '/proc' ? ['10'] : present ? ['3'] : []),
        readlink: () => render,
        readFile: () => fdinfo('42', ns),
      },
      now: () => t,
    });
    reader.sample([pci]);
    present = false;
    t = 5000;
    expect(reader.sample([pci]).get(pci)).toBe(0);
    present = true;
    ns = 9e9;
    t = 10_000;
    expect(reader.sample([pci]).get(pci)).toBe(0);
  });
});
