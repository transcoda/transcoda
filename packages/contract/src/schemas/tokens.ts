import { TOKEN_SCOPES } from '@transcoda/shared';
import { z } from 'zod';

export const TokenScopeSchema = z.enum(TOKEN_SCOPES);

export const ApiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(TokenScopeSchema),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;

export const TokenCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  scopes: z.array(TokenScopeSchema).min(1),
  expiresAt: z.iso.datetime().optional(),
});
export type TokenCreateInput = z.infer<typeof TokenCreateInputSchema>;

export const TokenCreateOutputSchema = ApiTokenSchema.extend({ token: z.string() });
export type TokenCreateOutput = z.infer<typeof TokenCreateOutputSchema>;

export const TokenIdInputSchema = z.object({ id: z.string() });
export type TokenIdInput = z.infer<typeof TokenIdInputSchema>;
