// Tests only: a scripted stand-in for the forked plugin host.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  type HostMessage,
  type JsonValue,
  type PluginManifest,
  PROTOCOL_VERSION,
} from '@transcoda/shared';
import type { ChildLike, ForkOptions } from './process.ts';

export const TEST_MANIFEST: PluginManifest = {
  name: 'example',
  version: '1.0.0',
  sdk: '^1',
  nodes: ['example:echo'],
  integration: null,
  triggers: [],
  hooks: [],
};

export type Sent = { id: string; type: string; [k: string]: unknown };

export class FakeChild extends EventEmitter implements ChildLike {
  pid: number | undefined;
  connected = true;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: Sent[] = [];
  readonly signals: NodeJS.Signals[] = [];
  /** Throw this from `send` (e.g. ERR_IPC_CHANNEL_CLOSED). */
  sendError: Error | null = null;
  /** Answer `init` with `ready` automatically (default) or stay silent. */
  autoReady = true;
  manifest: PluginManifest = TEST_MANIFEST;
  integration: { settingsSchema: JsonValue; allowedOrigins: string[] } | null = null;
  /** Called with every non-init message; return a `result` body to answer it. */
  onCall:
    | ((msg: Sent) => { ok: true; result: JsonValue } | { ok: false; message: string } | null)
    | null = null;
  /** Exit when SIGTERM arrives (default) or ignore it (a hung host). */
  exitOnTerm = true;
  private dead = false;

  constructor(
    pid: number,
    readonly opts: ForkOptions,
  ) {
    super();
    this.pid = pid;
  }

  send(msg: unknown): boolean {
    if (this.sendError) throw this.sendError;
    const m = msg as Sent;
    this.sent.push(m);
    queueMicrotask(() => this.react(m));
    return true;
  }

  private react(m: Sent): void {
    if (m.type === 'init') {
      if (this.autoReady) this.emitReady(m.id);
      return;
    }
    if (m.type === 'fetch-result') return;
    const answer = this.onCall?.(m);
    if (answer) this.emitResult(m.id, answer);
  }

  emitReady(id = 'init'): void {
    this.deliver({
      v: PROTOCOL_VERSION,
      id,
      type: 'ready',
      manifest: this.manifest,
      nodes: [],
      integration: this.integration,
      triggers: [],
    });
  }

  emitResult(
    id: string,
    answer: { ok: true; result: JsonValue } | { ok: false; message: string },
  ): void {
    this.deliver(
      answer.ok
        ? { v: PROTOCOL_VERSION, id, type: 'result', ok: true, result: answer.result }
        : {
            v: PROTOCOL_VERSION,
            id,
            type: 'result',
            ok: false,
            error: { message: answer.message, retryable: false },
          },
    );
  }

  deliver(message: HostMessage): void {
    this.emit('message', message);
  }

  /** What `forkHost` reports when the host wrote something that is not a JSON frame. */
  badFrame(why: string): void {
    this.emit('bad-frame', why);
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === 'SIGKILL') this.exit(null, 'SIGKILL');
    else if (this.exitOnTerm) this.exit(null, 'SIGTERM');
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.dead) return;
    this.dead = true;
    this.connected = false;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
  }
}

/** A fork() that hands out FakeChild instances and remembers them. */
export function fakeFork(configure: (child: FakeChild, index: number) => void = () => {}): {
  fork(opts: ForkOptions): FakeChild;
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  return {
    children,
    fork(opts) {
      const child = new FakeChild(10_000 + children.length, opts);
      configure(child, children.length);
      children.push(child);
      return child;
    },
  };
}
