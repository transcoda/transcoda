// Runs ffmpeg in its own process group: progress from stdout, stderr to the job log, and
// pause/resume/kill sent to the whole group.
import { spawn } from 'node:child_process';
import { createWriteStream, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Logger } from '../logger.ts';
import { wrapChild } from './child-caps.ts';
import { type ProgressSample, parseProgressBlock } from './progress.ts';

export interface ProcessResult {
  code: number | null;
  signal: string | null;
  /** Set when the job log could not be written (stderr was still drained). */
  logError?: string;
}

export interface RunnerProcess {
  pid: number;
  pause(): void;
  resume(): void;
  kill(): void;
  done: Promise<ProcessResult>;
}

export interface SpawnOptions {
  logPath: string;
  onProgress(s: ProgressSample): void;
  /** Each stderr line as it arrives (it is written to the log too); throws are logged. */
  onStderrLine?(line: string): void;
  /** Written with the pid once ffmpeg runs (the job temp dir's `ffmpeg.pid`), removed when it ends. */
  pidFile?: string;
  /** Receives failed signals and throwing progress callbacks; without it they are swallowed. */
  log?: Logger;
  /** How long `done` waits for stdout/stderr to close after the exit (default 2000 ms). */
  exitGraceMs?: number;
}

export interface ProcessSpawner {
  spawn(file: string, args: string[], opts: SpawnOptions): RunnerProcess;
}

/** Lines kept while waiting for a block's `progress=` line (ffmpeg writes ~12 per block). */
const MAX_BLOCK_LINES = 100;
const DEFAULT_EXIT_GRACE_MS = 2000;

/** Process groups of running ffmpeg children, killed when this process exits. */
const liveGroups = new Set<number>();
let exitHandlerInstalled = false;

/** @internal Test helper: the pids (= process group ids) of every ffmpeg child still running. */
export function liveProcessGroups(): number[] {
  return [...liveGroups];
}

/** SIGKILLs every live group. Synchronous, so it is safe in a `process.on('exit')` handler. */
export function killLiveProcessGroups(): void {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Gone already, or not ours to kill; nothing more can be done while exiting.
    }
  }
  liveGroups.clear();
}

function installExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on('exit', killLiveProcessGroups);
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? String(err);
}

/**
 * The real spawner. `args` is an argv array and no shell is involved. The child leads a new
 * process group (`detached`), so signals go to `-pid` and reach anything ffmpeg starts. Signals
 * never throw: they are no-ops before a pid exists and after the exit (a pgid could be reused),
 * `ESRCH` is ignored and any other failure is logged. `done` resolves once the process exited and
 * its output and the log are flushed (`close`), or `exitGraceMs` after the exit when something
 * keeps the pipes open (the rest of the group is then SIGKILLed); it rejects when the file could
 * not be spawned. While running, the group is registered for the exit-time kill.
 */
export const nodeSpawner: ProcessSpawner = {
  spawn(file, args, opts) {
    const cmd = wrapChild(file, args);
    const child = spawn(cmd.file, cmd.args, {
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid ?? -1;
    let running = child.pid !== undefined;
    if (running) {
      installExitHandler();
      liveGroups.add(pid);
      if (opts.pidFile) {
        try {
          writeFileSync(opts.pidFile, `${pid}\n`);
        } catch (err) {
          opts.log?.warn({ msg: 'ffmpeg pid file not written', code: errorCode(err) });
        }
      }
    }

    let logError: string | undefined;
    const log = createWriteStream(opts.logPath, { flags: 'a' });
    const logClosed = new Promise<void>((resolve) => {
      log.on('close', resolve);
      log.on('error', (err) => {
        logError = err.message;
        // Keep draining stderr so ffmpeg never blocks on a full pipe.
        child.stderr.unpipe(log);
        child.stderr.resume();
        resolve();
      });
    });
    child.stderr.pipe(log);
    if (opts.onStderrLine) {
      const onLine = opts.onStderrLine;
      createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY }).on(
        'line',
        (line) => {
          try {
            onLine(line);
          } catch (err) {
            opts.log?.error({ msg: 'stderr callback failed', error: String(err) });
          }
        },
      );
    }

    let block: string[] = [];
    createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on(
      'line',
      (line) => {
        block.push(line);
        if (block.length > MAX_BLOCK_LINES) block.shift();
        if (!line.startsWith('progress=')) return;
        const sample = parseProgressBlock(block);
        block = [];
        if (!sample) return;
        try {
          opts.onProgress(sample);
        } catch (err) {
          opts.log?.error({ msg: 'progress callback failed', error: String(err) });
        }
      },
    );

    const done = new Promise<ProcessResult>((resolve, reject) => {
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const finish = (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        running = false;
        clearTimeout(grace);
        liveGroups.delete(pid);
        if (opts.pidFile) rmSync(opts.pidFile, { force: true });
        void logClosed.then(() =>
          resolve(logError === undefined ? { code, signal } : { code, signal, logError }),
        );
      };
      child.on('error', (err) => {
        if (running || settled) return; // spawned fine; errors here are failed signals
        settled = true;
        log.end();
        reject(err);
      });
      child.on('exit', (code, signal) => {
        running = false;
        if (settled) return;
        grace = setTimeout(() => {
          if (settled) return;
          // Something else in the group holds the pipes open: end it and stop waiting.
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            // ESRCH: the group is already gone.
          }
          child.stdout.destroy();
          child.stderr.unpipe(log);
          child.stderr.destroy();
          log.end();
          finish(code, signal);
        }, opts.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS);
      });
      child.on('close', (code, signal) => finish(code, signal));
    });

    function signalGroup(sig: NodeJS.Signals): void {
      if (!running) return;
      try {
        process.kill(-pid, sig);
      } catch (err) {
        const code = errorCode(err);
        if (code !== 'ESRCH') opts.log?.warn({ msg: 'ffmpeg signal failed', signal: sig, code });
      }
    }

    return {
      pid,
      pause: () => signalGroup('SIGSTOP'),
      resume: () => signalGroup('SIGCONT'),
      kill: () => signalGroup('SIGKILL'),
      done,
    };
  },
};

interface FakeProcess {
  opts: SpawnOptions;
  finish(result: ProcessResult): void;
}

/**
 * A spawner for tests: records every spawn and signal; the test drives the latest process with
 * `emitProgress` and `exit`. Like the real one, `kill()` ends the process with signal SIGKILL and
 * signals after the end are no-ops (not recorded).
 */
export class FakeSpawner implements ProcessSpawner {
  readonly calls: { file: string; args: string[]; logPath: string }[] = [];
  readonly signals: string[] = [];
  private readonly processes: FakeProcess[] = [];

  spawn(file: string, args: string[], opts: SpawnOptions): RunnerProcess {
    this.calls.push({ file, args: [...args], logPath: opts.logPath });
    let ended = false;
    let settle: (r: ProcessResult) => void = () => {};
    const done = new Promise<ProcessResult>((resolve) => {
      settle = resolve;
    });
    const finish = (result: ProcessResult) => {
      if (ended) return;
      ended = true;
      settle(result);
    };
    const signal = (sig: string) => {
      if (!ended) this.signals.push(sig);
    };
    this.processes.push({ opts, finish });
    return {
      pid: 10_000 + this.processes.length,
      pause: () => signal('SIGSTOP'),
      resume: () => signal('SIGCONT'),
      kill: () => {
        signal('SIGKILL');
        finish({ code: null, signal: 'SIGKILL' });
      },
      done,
    };
  }

  /** Delivers a progress sample to the latest process. */
  emitProgress(sample: ProgressSample): void {
    this.latest().opts.onProgress(sample);
  }

  /** Delivers a stderr line to the latest process's `onStderrLine`. */
  emitStderr(line: string): void {
    this.latest().opts.onStderrLine?.(line);
  }

  /** Ends the latest process with an exit code (ignored once it has ended). */
  exit(code: number, signal: string | null = null): void {
    this.latest().finish({ code, signal });
  }

  private latest(): FakeProcess {
    const p = this.processes.at(-1);
    if (!p) throw new Error('FakeSpawner: nothing spawned');
    return p;
  }
}
