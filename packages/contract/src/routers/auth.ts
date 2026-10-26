import { oc } from '@orpc/contract';
import { mutationErrors, pickErrors } from '../errors.ts';
import { publicSpec } from '../openapi.ts';
import {
  AuthUserOutputSchema,
  ChangePasswordInputSchema,
  CredentialsSchema,
  MeOutputSchema,
  OkOutputSchema,
} from '../schemas/auth.ts';

export const auth = {
  setup: oc
    .route({
      method: 'POST',
      path: '/auth/setup',
      tags: ['auth'],
      summary: 'Create the first user',
      spec: publicSpec,
    })
    .errors(pickErrors('SETUP_ALREADY_DONE', 'CSRF_FAILED'))
    .input(CredentialsSchema)
    .output(AuthUserOutputSchema),
  login: oc
    .route({
      method: 'POST',
      path: '/auth/login',
      tags: ['auth'],
      summary: 'Log in',
      spec: publicSpec,
    })
    .errors(pickErrors('INVALID_CREDENTIALS', 'RATE_LIMITED', 'CSRF_FAILED'))
    .input(CredentialsSchema)
    .output(AuthUserOutputSchema),
  logout: oc
    .route({ method: 'POST', path: '/auth/logout', tags: ['auth'], summary: 'Log out' })
    .errors(mutationErrors)
    .output(OkOutputSchema),
  me: oc
    .route({
      method: 'GET',
      path: '/auth/me',
      tags: ['auth'],
      summary: 'Current session and setup state',
      spec: publicSpec,
    })
    .output(MeOutputSchema),
  /** A person's browser session only; signs out the user's other sessions (API tokens keep working). */
  changePassword: oc
    .route({ method: 'POST', path: '/auth/password', tags: ['auth'], summary: 'Change password' })
    .errors({ ...mutationErrors, ...pickErrors('INVALID_CREDENTIALS', 'RATE_LIMITED') })
    .input(ChangePasswordInputSchema)
    .output(OkOutputSchema),
};
