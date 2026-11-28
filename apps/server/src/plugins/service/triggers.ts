// A plugin trigger, as core calls it when its webhook arrives (docs/dev/plugins-host.md,
// "Triggers"). The plugin's answer is untrusted: it is checked here before core acts on it.
import type { JsonValue } from '@transcoda/shared';
import { z } from 'zod';
import type { TriggerMetadata } from '../../db/repos/plugins.ts';
import { PluginCallError } from '../runtime/process.ts';
import type { PluginSupervisor } from '../runtime/supervisor.ts';
import type { Installed } from './types.ts';

/** The most files one trigger call may name; a larger answer is refused as invalid. */
export const TRIGGER_MAX_FILES = 100;
const MAX_TEXT = 2000;
const MAX_PATH = 4096;

/** How a trigger's caller presents its token: Basic auth (the password) or a named header. */
export type TriggerAuth = { basic: true } | { header: string };

const TriggerAuthSchema = z.union([
  z.object({ basic: z.literal(true) }),
  z.object({ header: z.string().min(1).max(200) }),
]);

const TriggerResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('files'),
    files: z
      .array(
        z.object({
          path: z.string().min(1).max(MAX_PATH),
          note: z.string().max(MAX_TEXT),
          dedupKey: z.string().max(MAX_TEXT).optional(),
        }),
      )
      .max(TRIGGER_MAX_FILES),
  }),
  z.object({ kind: z.literal('ignore'), reason: z.string().max(MAX_TEXT) }),
  z.object({ kind: z.literal('test'), message: z.string().max(MAX_TEXT) }),
]);
export type TriggerAnswer = z.infer<typeof TriggerResultSchema>;

/** The request a trigger's `handle` gets (credentials already removed by the caller). */
export interface TriggerRequest {
  method: string;
  headers: Record<string, string>;
  body: JsonValue;
}

export type TriggerCall =
  | { ok: true; answer: TriggerAnswer }
  /** `unavailable`: the plugin is not running. `failed`: it threw, timed out or answered nonsense. */
  | { ok: false; kind: 'unavailable' | 'failed'; message: string };

export interface PluginTrigger {
  auth: TriggerAuth;
  call(request: TriggerRequest): Promise<TriggerCall>;
}

/** Trigger `id` of the installed plugin `rec`, or null when it has none by that id. */
export function pluginTrigger(
  supervisor: Pick<PluginSupervisor, 'call' | 'status'>,
  rec: Installed | null,
  id: string,
): PluginTrigger | null {
  const meta: TriggerMetadata | undefined = rec?.triggers.find((t) => t.id === id);
  if (!rec || !meta) return null;
  const auth = TriggerAuthSchema.safeParse(meta.auth);
  // A trigger that announced an auth core does not know is never callable.
  if (!auth.success) return null;
  return {
    auth: auth.data,
    async call(request) {
      const state = supervisor.status(rec.name)?.state ?? 'not installed';
      if (state !== 'running') {
        return { ok: false, kind: 'unavailable', message: `plugin ${rec.name} is ${state}` };
      }
      try {
        // Trigger settings are not stored yet: the plugin gets its schema's defaults.
        const r = await supervisor.call(rec.name, {
          type: 'trigger',
          triggerId: id,
          request: { ...request, settings: {} } as unknown as JsonValue,
        });
        if (!r.ok) return { ok: false, kind: 'failed', message: r.error.message };
        const answer = TriggerResultSchema.safeParse(r.result);
        if (!answer.success) {
          return {
            ok: false,
            kind: 'failed',
            message: 'the plugin answered with an invalid result',
          };
        }
        return { ok: true, answer: answer.data };
      } catch (err) {
        if (err instanceof PluginCallError) {
          // Retryable: it stopped or restarted meanwhile; anything else (a timeout) is its fault.
          return {
            ok: false,
            kind: err.retryable ? 'unavailable' : 'failed',
            message: err.message,
          };
        }
        throw err;
      }
    },
  };
}
