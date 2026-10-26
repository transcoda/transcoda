import type { RouterClient } from '@orpc/server';
import type { TokenScope } from '@transcoda/shared';
import { z } from 'zod';
import { hasScope } from '../auth/tokens.ts';
import type { AppDeps, AuthContext } from '../rpc/context.ts';
import type { Router } from '../rpc/router.ts';

export type TokenAuth = Extract<AuthContext, { kind: 'token' }>;

export interface ToolContext {
  /** The oRPC router called in process with the token's context: scopes, validation and redaction are the REST ones. */
  api: RouterClient<Router>;
  deps: AppDeps;
  auth: TokenAuth;
}

export interface ToolOk<T> {
  text: string;
  data: T;
}

export interface ToolDef<
  In extends z.ZodRawShape = z.ZodRawShape,
  Out extends z.ZodRawShape = z.ZodRawShape,
> {
  name: string;
  title: string;
  description: string;
  /** Any one of these lets the token see and call the tool. */
  scopes: TokenScope[];
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint: false;
  };
  input: In;
  /** Reject arguments the input does not name (instead of dropping them silently). */
  strict?: boolean;
  output: Out;
  run(ctx: ToolContext, args: z.infer<z.ZodObject<In>>): Promise<ToolOk<z.infer<z.ZodObject<Out>>>>;
}

export function defineTool<In extends z.ZodRawShape, Out extends z.ZodRawShape>(
  def: ToolDef<In, Out>,
): ToolDef<In, Out> {
  return def;
}

// biome-ignore lint/suspicious/noExplicitAny: a registry holds tools of every shape
export type AnyToolDef = ToolDef<any, any>;

/** The tools a token may see and call: any one of a tool's scopes is enough; registration order kept. */
export function toolsFor(scopes: TokenScope[], tools: AnyToolDef[]): AnyToolDef[] {
  return tools.filter((def) => def.scopes.some((scope) => hasScope(scopes, scope)));
}

/** A failure a tool raises itself; it becomes an `isError` result like a defined oRPC error. */
export class ToolFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ToolFailure';
  }
}

/** 'via MCP' or 'via MCP: <note>' (the note is already at most 111 characters by the input schema). */
export const MCP_NOTE_PREFIX = 'via MCP';
export function mcpNote(note: string | undefined): string {
  return note === undefined || note === '' ? MCP_NOTE_PREFIX : `${MCP_NOTE_PREFIX}: ${note}`;
}

export const NoteInput = z
  .string()
  .trim()
  .max(111)
  .describe('Shown in the version history as "via MCP: <note>"');
