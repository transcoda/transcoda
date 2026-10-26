import { oc } from '@orpc/contract';
import { authedErrors, mutationErrors, pickErrors } from '../errors.ts';
import { OkOutputSchema } from '../schemas/auth.ts';
import {
  LibrariesListOutputSchema,
  LibraryBrowseInputSchema,
  LibraryBrowseOutputSchema,
  LibraryCreateInputSchema,
  LibraryIdInputSchema,
  LibrarySchema,
  LibraryUpdateInputSchema,
} from '../schemas/libraries.ts';

const tags = ['libraries'];

export const libraries = {
  list: oc
    .route({ method: 'GET', path: '/libraries', tags, summary: 'List libraries' })
    .errors(authedErrors)
    .output(LibrariesListOutputSchema),
  get: oc
    .route({ method: 'GET', path: '/libraries/{id}', tags, summary: 'Get a library' })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND') })
    .input(LibraryIdInputSchema)
    .output(LibrarySchema),
  browse: oc
    .route({
      method: 'GET',
      path: '/libraries/{id}/browse',
      tags,
      summary: 'List the sub-folders and media files of a library folder',
    })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND', 'PATH_REJECTED') })
    .input(LibraryBrowseInputSchema)
    .output(LibraryBrowseOutputSchema),
  create: oc
    .route({ method: 'POST', path: '/libraries', tags, summary: 'Create a library' })
    .errors({ ...mutationErrors, ...pickErrors('LIBRARY_PATH_INVALID') })
    .input(LibraryCreateInputSchema)
    .output(LibrarySchema),
  update: oc
    .route({ method: 'PATCH', path: '/libraries/{id}', tags, summary: 'Change a library' })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND', 'LIBRARY_PATH_INVALID') })
    .input(LibraryUpdateInputSchema)
    .output(LibrarySchema),
  dismissNotices: oc
    .route({
      method: 'POST',
      path: '/libraries/notices/dismiss',
      tags,
      summary: 'Dismiss the library upgrade notices',
    })
    .errors(mutationErrors)
    .output(OkOutputSchema),
  delete: oc
    .route({ method: 'DELETE', path: '/libraries/{id}', tags, summary: 'Delete a library' })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND', 'LIBRARY_BUSY') })
    .input(LibraryIdInputSchema)
    .output(OkOutputSchema),
};
