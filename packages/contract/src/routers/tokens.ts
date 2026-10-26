import { oc } from '@orpc/contract';
import { z } from 'zod';
import { authedErrors, mutationErrors, pickErrors } from '../errors.ts';
import { OkOutputSchema } from '../schemas/auth.ts';
import {
  ApiTokenSchema,
  TokenCreateInputSchema,
  TokenCreateOutputSchema,
  TokenIdInputSchema,
} from '../schemas/tokens.ts';

export const tokens = {
  create: oc
    .route({ method: 'POST', path: '/tokens', tags: ['tokens'], summary: 'Create an API token' })
    .errors({ ...mutationErrors, ...pickErrors('INVALID_EXPIRY') })
    .input(TokenCreateInputSchema)
    .output(TokenCreateOutputSchema),
  list: oc
    .route({ method: 'GET', path: '/tokens', tags: ['tokens'], summary: 'List API tokens' })
    .errors(authedErrors)
    .output(z.array(ApiTokenSchema)),
  revoke: oc
    .route({
      method: 'DELETE',
      path: '/tokens/{id}',
      tags: ['tokens'],
      summary: 'Revoke an API token',
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND') })
    .input(TokenIdInputSchema)
    .output(OkOutputSchema),
};
