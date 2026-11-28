import { describe, expect, it } from 'vitest';
import {
  AuthUserOutputSchema,
  ChangePasswordInputSchema,
  CredentialsSchema,
  contract,
  MeOutputSchema,
} from '../index.ts';

describe('auth router', () => {
  it('rejects short passwords and usernames with spaces', () => {
    expect(CredentialsSchema.safeParse({ username: 'admin', password: 'short' }).success).toBe(
      false,
    );
    expect(
      CredentialsSchema.safeParse({ username: 'ad min', password: 'x'.repeat(12) }).success,
    ).toBe(false);
    expect(
      CredentialsSchema.safeParse({ username: 'admin', password: 'x'.repeat(12) }).success,
    ).toBe(true);
  });

  it('wraps the user as { user }', () => {
    const user = { id: 'u1', username: 'admin', createdAt: '2026-01-01T00:00:00Z' };
    expect(AuthUserOutputSchema.safeParse({ user }).success).toBe(true);
    expect(AuthUserOutputSchema.safeParse(user).success).toBe(false);
    for (const proc of [contract.auth.setup, contract.auth.login]) {
      const out = proc['~orpc'].outputSchema;
      expect(out?.['~standard'].validate({ user })).not.toHaveProperty('issues');
      expect(out?.['~standard'].validate(user)).toHaveProperty('issues');
    }
  });

  it('auth.me carries the appearance', () => {
    const base = { setupRequired: false, user: null, csrfToken: null };
    expect(MeOutputSchema.safeParse(base).success).toBe(false);
    expect(
      MeOutputSchema.safeParse({ ...base, appearance: { theme: 'system', serverName: null } })
        .success,
    ).toBe(true);
    expect(
      MeOutputSchema.safeParse({ ...base, appearance: { theme: 'blue', serverName: null } })
        .success,
    ).toBe(false);
  });

  it('a new password follows the setup rule', () => {
    expect(
      ChangePasswordInputSchema.safeParse({ currentPassword: 'x', newPassword: 'a'.repeat(11) })
        .success,
    ).toBe(false);
    expect(
      ChangePasswordInputSchema.safeParse({ currentPassword: '', newPassword: 'a'.repeat(12) })
        .success,
    ).toBe(false);
    expect(
      ChangePasswordInputSchema.safeParse({ currentPassword: 'x', newPassword: 'a'.repeat(12) })
        .success,
    ).toBe(true);
  });
});
