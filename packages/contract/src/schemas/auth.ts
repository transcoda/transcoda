import { z } from 'zod';
import { ThemeSchema } from './settings.ts';
import { UserSchema } from './user.ts';

export const CredentialsSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9._-]+$/i),
  password: z.string().min(12).max(1024),
});
export type Credentials = z.infer<typeof CredentialsSchema>;

/** Applied before sign-in and on every page. */
export const AppearanceSchema = z.object({ theme: ThemeSchema, serverName: z.string().nullable() });
export type Appearance = z.infer<typeof AppearanceSchema>;

export const MeOutputSchema = z.object({
  setupRequired: z.boolean(),
  user: UserSchema.nullable(),
  csrfToken: z.string().nullable(),
  /** serverName is null for an anonymous caller. */
  appearance: AppearanceSchema,
});
export type MeOutput = z.infer<typeof MeOutputSchema>;

export const ChangePasswordInputSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  /** The same 12..1024 rule as setup. */
  newPassword: CredentialsSchema.shape.password,
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;

export const OkOutputSchema = z.object({ ok: z.literal(true) });
export type OkOutput = z.infer<typeof OkOutputSchema>;

export const AuthUserOutputSchema = z.object({ user: UserSchema });
export type AuthUserOutput = z.infer<typeof AuthUserOutputSchema>;
