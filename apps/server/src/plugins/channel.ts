// The server end of a plugin host's message channel. The host keeps Node's own IPC API
// (`process.send`, `process.on('message')`) in `json` serialization, but the server never lets
// Node parse what arrives: fd 3 is a plain pipe the server reads and frames itself. Node's channel
// reader throws a malformed frame (V8 structured clone and JSON alike) from inside its own socket
// callback, where nothing can catch it, and that takes the whole server down. Here a malformed
// frame is a per-plugin error instead.
import type { Duplex } from 'node:stream';
import { MAX_MESSAGE_BYTES } from '@transcoda/shared';

/** A frame's characters never exceed its bytes; the host caps its messages at MAX_MESSAGE_BYTES. */
export const MAX_FRAME_CHARS = MAX_MESSAGE_BYTES + 64 * 1024;

/** The child's env that makes Node open fd 3 as its IPC channel, newline-delimited JSON. */
export const CHANNEL_ENV = {
  NODE_CHANNEL_FD: '3',
  NODE_CHANNEL_SERIALIZATION_MODE: 'json',
} as const;

/**
 * Splits newline-delimited JSON. After the first bad frame (not JSON, or longer than `maxChars`)
 * it reports once and ignores everything after it: the stream can no longer be trusted.
 */
export function createFrameReader(opts: {
  maxChars?: number;
  onMessage(message: unknown): void;
  onBadFrame(why: string): void;
}): (chunk: string) => void {
  const maxChars = opts.maxChars ?? MAX_FRAME_CHARS;
  let rest = '';
  let broken = false;
  const fail = (why: string): void => {
    broken = true;
    rest = '';
    opts.onBadFrame(why);
  };
  return (chunk) => {
    if (broken) return;
    // Only the new chunk can hold the next newline: no rescan of a long partial frame.
    const from = rest.length;
    rest += chunk;
    let at = rest.indexOf('\n', from);
    while (at >= 0) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      if (line.length > maxChars)
        return fail(`malformed message frame: over ${maxChars} characters`);
      if (line !== '') {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return fail('malformed message frame: not JSON');
        }
        opts.onMessage(message);
        if (broken) return;
      }
      at = rest.indexOf('\n');
    }
    if (rest.length > maxChars) fail(`malformed message frame: over ${maxChars} characters`);
  };
}

/** Node's own internal messages (`{ cmd: 'NODE_…' }`, handle passing, cluster): never ours. */
function isInternal(m: unknown): boolean {
  if (typeof m !== 'object' || m === null) return false;
  const cmd = (m as { cmd?: unknown }).cmd;
  return typeof cmd === 'string' && cmd.startsWith('NODE_');
}

export interface Channel {
  readonly connected: boolean;
  send(message: unknown): boolean;
}

/**
 * Wires `socket` (the child's fd 3) as a channel: `message` for each frame, `bad-frame` (once) for a
 * malformed one, `disconnect` when it closes.
 */
export function openChannel(
  socket: Duplex,
  emit: (event: 'message' | 'bad-frame' | 'disconnect', arg?: unknown) => void,
): Channel {
  let open = true;
  const read = createFrameReader({
    onMessage: (m) => {
      if (!isInternal(m)) emit('message', m);
    },
    onBadFrame: (why) => emit('bad-frame', why),
  });
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => read(chunk));
  // A broken pipe is the child going away: its `exit` tells the rest.
  socket.on('error', () => {});
  socket.on('close', () => {
    if (!open) return;
    open = false;
    emit('disconnect');
  });
  return {
    get connected() {
      return open && !socket.destroyed && socket.writable;
    },
    send(message) {
      if (!open || socket.destroyed || !socket.writable) throw new Error('ERR_IPC_CHANNEL_CLOSED');
      return socket.write(`${JSON.stringify(message)}\n`);
    },
  };
}
