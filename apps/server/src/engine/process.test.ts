import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger.ts';
import { fixturePath, fixturesAvailable, tempDir, toolPaths } from './fixtures.ts';
import {
  FakeSpawner,
  liveProcessGroups,
  nodeSpawner,
  type ProcessResult,
  type RunnerProcess,
} from './process.ts';
import type { ProgressSample } from './progress.ts';

const execFileAsync = promisify(execFile);

describe('FakeSpawner', () => {
  it('records spawns and signals and resolves done on exit', async () => {
    const spawner = new FakeSpawner();
    const samples: ProgressSample[] = [];
    const p = spawner.spawn('ffmpeg', ['-i', '/in.mkv'], {
      logPath: '/logs/j.log',
      onProgress: (s) => samples.push(s),
    });
    expect(spawner.calls).toEqual([
      { file: 'ffmpeg', args: ['-i', '/in.mkv'], logPath: '/logs/j.log' },
    ]);
    spawner.emitProgress({ outTimeSeconds: 1, speed: 1, fps: 25, sizeBytes: 10 });
    expect(samples).toHaveLength(1);
    p.pause();
    p.resume();
    spawner.exit(0);
    await expect(p.done).resolves.toEqual({ code: 0, signal: null });
    expect(spawner.signals).toEqual(['SIGSTOP', 'SIGCONT']);
  });

  it('kill() records SIGKILL and ends the process like a real kill', async () => {
    const spawner = new FakeSpawner();
    const p = spawner.spawn('ffmpeg', [], { logPath: '/l', onProgress: () => {} });
    p.kill();
    await expect(p.done).resolves.toEqual({ code: null, signal: 'SIGKILL' });
    expect(spawner.signals).toEqual(['SIGKILL']);
  });

  it('signals after the end are no-ops and not recorded', async () => {
    const spawner = new FakeSpawner();
    const p = spawner.spawn('ffmpeg', [], { logPath: '/l', onProgress: () => {} });
    spawner.exit(1);
    p.pause();
    p.resume();
    p.kill();
    await expect(p.done).resolves.toEqual({ code: 1, signal: null });
    expect(spawner.signals).toEqual([]);
  });
});

/** Polls `cond` every 10 ms; rejects with `what` when the process ends first or after `ms`. */
function waitFor(cond: () => boolean, p: RunnerProcess, what: string, ms = 20_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const polled = new Promise<void>((resolve, reject) => {
    const started = Date.now();
    timer = setInterval(() => {
      if (cond()) resolve();
      else if (Date.now() - started > ms) reject(new Error(`timed out waiting for ${what}`));
    }, 10);
  });
  const ended = p.done.then(
    (r: ProcessResult) => {
      throw new Error(`process ended (${JSON.stringify(r)}) before ${what}`);
    },
    (err: unknown) => {
      throw new Error(`process failed (${String(err)}) before ${what}`);
    },
  );
  return Promise.race([polled, ended]).finally(() => clearInterval(timer));
}

/** True once the process group `pid` no longer exists. */
function groupGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function eventually(cond: () => boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

/** ps state of a pid ('T' when stopped), or '' when it is gone. */
async function psState(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'stat=', '-p', String(pid)]);
    return stdout.trim();
  } catch {
    return '';
  }
}

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('nodeSpawner (sh stand-ins for ffmpeg)', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await tempDir('process-');
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sh = (
    name: string,
    script: string,
    extra: Partial<Parameters<typeof nodeSpawner.spawn>[2]> = {},
  ) =>
    nodeSpawner.spawn('sh', ['-c', script], {
      logPath: join(dir, `${name}.log`),
      onProgress: () => {},
      ...extra,
    });

  it('rejects done when the file cannot be spawned; signals before a pid are no-ops', async () => {
    const kill = vi.spyOn(process, 'kill');
    const p = nodeSpawner.spawn(join(dir, 'no-such-ffmpeg'), [], {
      logPath: join(dir, 'x.log'),
      onProgress: () => {},
    });
    p.pause();
    p.resume();
    p.kill();
    await expect(p.done).rejects.toThrow(/ENOENT/);
    expect(kill).not.toHaveBeenCalled();
  });

  it('signals after done are no-ops', async () => {
    const p = sh('after-done', 'exit 3');
    await expect(p.done).resolves.toEqual({ code: 3, signal: null });
    const kill = vi.spyOn(process, 'kill');
    p.pause();
    p.resume();
    p.kill();
    expect(kill).not.toHaveBeenCalled();
  });

  it('a throwing progress callback is logged and later samples still arrive', async () => {
    const log = fakeLogger();
    const seen: number[] = [];
    const p = sh(
      'throwing',
      'printf "out_time_us=1000000\\nprogress=continue\\nout_time_us=2000000\\nprogress=end\\n"',
      {
        log,
        onProgress: (s) => {
          seen.push(s.outTimeSeconds);
          if (seen.length === 1) throw new Error('boom');
        },
      },
    );
    await expect(p.done).resolves.toEqual({ code: 0, signal: null });
    expect(seen).toEqual([1, 2]);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'progress callback failed', error: 'Error: boom' }),
    );
  });

  it('a long run of lines without progress= does not break the next block', async () => {
    const seen: number[] = [];
    const p = sh(
      'junk',
      'i=0; while [ $i -lt 500 ]; do echo junk=$i; i=$((i+1)); done; printf "out_time_us=4000000\\nprogress=end\\n"',
      { onProgress: (s) => seen.push(s.outTimeSeconds) },
    );
    await expect(p.done).resolves.toEqual({ code: 0, signal: null });
    expect(seen).toEqual([4]);
  });

  it('reports a log write error on the result and still finishes', async () => {
    const p = nodeSpawner.spawn('sh', ['-c', 'echo to-stderr >&2'], {
      logPath: join(dir, 'missing-dir', 'x.log'),
      onProgress: () => {},
    });
    const r = await p.done;
    expect(r).toMatchObject({ code: 0, signal: null });
    expect(r.logError).toMatch(/ENOENT/);
  });

  it('resolves after the exit grace when the group keeps the pipes open, and ends the group', async () => {
    const started = Date.now();
    const p = sh('grace', 'sleep 30 & exit 0', { exitGraceMs: 100 });
    await expect(p.done).resolves.toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await eventually(() => groupGone(p.pid))).toBe(true);
  });

  it('registers the group and writes the pid file while running; both are cleared at the end', async () => {
    const pidFile = join(dir, 'ffmpeg.pid');
    const p = sh('pidfile', 'sleep 30', { pidFile });
    expect(liveProcessGroups()).toContain(p.pid);
    expect(await readFile(pidFile, 'utf8')).toBe(`${p.pid}\n`);
    p.kill();
    await expect(p.done).resolves.toEqual({ code: null, signal: 'SIGKILL' });
    expect(liveProcessGroups()).not.toContain(p.pid);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('kills every live group when the server process exits', async () => {
    const moduleUrl = new URL('./process.ts', import.meta.url).href;
    const script = [
      `const { nodeSpawner } = await import(${JSON.stringify(moduleUrl)});`,
      `const p = nodeSpawner.spawn('sh', ['-c', 'sleep 30'], { logPath: ${JSON.stringify(join(dir, 'exit.log'))}, onProgress() {} });`,
      'console.log(p.pid);',
      'setTimeout(() => process.exit(0), 100);',
    ].join('\n');
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script]);
    const pid = Number(stdout.trim());
    expect(pid).toBeGreaterThan(0);
    expect(await eventually(() => groupGone(pid))).toBe(true);
  });
});

describe.skipIf(!fixturesAvailable())('nodeSpawner with real ffmpeg', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await tempDir('process-');
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /**
   * libx264 encode of compliant.mkv (320×180, 3 s). `endless` loops the input until killed, so the
   * signal tests never depend on how fast the machine encodes.
   */
  function encode(name: string, samples: ProgressSample[], endless = false): RunnerProcess {
    return nodeSpawner.spawn(
      toolPaths().ffmpegPath,
      [
        '-nostdin',
        '-y',
        '-nostats',
        '-progress',
        'pipe:1',
        ...(endless ? ['-stream_loop', '-1'] : []),
        '-i',
        fixturePath('compliant.mkv'),
        '-map',
        '0:v:0',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        join(dir, `${name}.mkv`),
      ],
      { logPath: join(dir, `${name}.log`), onProgress: (s) => samples.push(s) },
    );
  }

  it('encodes with progress samples, exit code 0 and a log file', async () => {
    const samples: ProgressSample[] = [];
    const p = encode('plain', samples);
    expect(p.pid).toBeGreaterThan(0);
    await expect(p.done).resolves.toEqual({ code: 0, signal: null });
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.at(-1)?.outTimeSeconds).toBeGreaterThan(0);
    expect((await stat(join(dir, 'plain.mkv'))).size).toBeGreaterThan(0);
    expect((await readFile(join(dir, 'plain.log'), 'utf8')).length).toBeGreaterThan(0);
  });

  it('pause() stops the process group and resume() lets progress advance again', async () => {
    const samples: ProgressSample[] = [];
    const p = encode('paused', samples, true);
    try {
      await waitFor(() => samples.length > 0, p, 'the first progress sample');
      p.pause();
      await new Promise((r) => setTimeout(r, 100));
      expect(await psState(p.pid)).toMatch(/^T/);
      const count = samples.length;
      const outTime = samples.at(-1)?.outTimeSeconds ?? 0;
      p.resume();
      expect(await psState(p.pid)).not.toMatch(/^T/);
      await waitFor(
        () => samples.length > count && (samples.at(-1)?.outTimeSeconds ?? 0) > outTime,
        p,
        'progress after resume',
      );
    } finally {
      p.kill();
    }
    await expect(p.done).resolves.toEqual({ code: null, signal: 'SIGKILL' });
  }, 60_000);

  it('kill() ends the whole process group with SIGKILL', async () => {
    const samples: ProgressSample[] = [];
    const p = encode('killed', samples, true);
    await waitFor(() => samples.length > 0, p, 'the first progress sample');
    p.kill();
    await expect(p.done).resolves.toEqual({ code: null, signal: 'SIGKILL' });
    expect(groupGone(p.pid)).toBe(true);
  }, 30_000);

  it('kill() on a paused process still ends it', async () => {
    const samples: ProgressSample[] = [];
    const p = encode('paused-killed', samples, true);
    await waitFor(() => samples.length > 0, p, 'the first progress sample');
    p.pause();
    p.kill();
    await expect(p.done).resolves.toEqual({ code: null, signal: 'SIGKILL' });
  }, 30_000);
});
