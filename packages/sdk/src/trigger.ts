import type { JsonValue } from '@transcoda/shared';
import { z } from 'zod';
import type { PluginContext } from './context.ts';

export type TriggerAuth = { header: string } | { basic: true };

export interface TriggerRequest {
  method: string;
  headers: Record<string, string>;
  body: JsonValue;
}

export type TriggerResult =
  | { kind: 'files'; files: Array<{ path: string; note: string; dedupKey?: string | undefined }> }
  | { kind: 'ignore'; reason: string }
  | { kind: 'test'; message: string };

export interface Trigger<Shape extends z.ZodRawShape = z.ZodRawShape> {
  id: string;
  title: string;
  description: string;
  icon: string;
  settings: z.ZodObject<Shape>;
  auth: TriggerAuth;
  handle(
    ctx: PluginContext,
    request: TriggerRequest,
    settings: z.infer<z.ZodObject<Shape>>,
  ): Promise<TriggerResult>;
}

// biome-ignore lint/suspicious/noExplicitAny: a plugin holds triggers of every settings shape
export type AnyTrigger = Trigger<any>;

export function defineTrigger<Shape extends z.ZodRawShape>(t: Trigger<Shape>): Trigger<Shape> {
  return t;
}

export function triggerMetadata(t: AnyTrigger): {
  id: string;
  title: string;
  description: string;
  icon: string;
  settingsSchema: JsonValue;
  auth: TriggerAuth;
} {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    icon: t.icon,
    settingsSchema: z.toJSONSchema(t.settings, { io: 'input' }) as JsonValue,
    auth: t.auth,
  };
}
