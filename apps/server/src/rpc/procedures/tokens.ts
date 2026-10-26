import { InvalidTokenExpiryError } from '../../auth/tokens.ts';
import { os, requireSession } from '../middleware.ts';

// Token management is session-only: an API token can never create, list or revoke tokens.
export const create = os.tokens.create.use(requireSession).handler(({ context, input, errors }) => {
  try {
    return context.deps.tokens.create(context.auth.user.id, input);
  } catch (e) {
    if (e instanceof InvalidTokenExpiryError) throw errors.INVALID_EXPIRY({ message: e.message });
    throw e;
  }
});

export const list = os.tokens.list
  .use(requireSession)
  .handler(({ context }) => context.deps.tokens.list(context.auth.user.id));

export const revoke = os.tokens.revoke.use(requireSession).handler(({ context, input, errors }) => {
  if (!context.deps.tokens.revoke(context.auth.user.id, input.id)) throw errors.NOT_FOUND();
  return { ok: true as const };
});
