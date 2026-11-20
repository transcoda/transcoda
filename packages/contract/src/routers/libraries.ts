import { oc } from '@orpc/contract';
import { authedErrors, mutationErrors, pickErrors } from '../errors.ts';
import { OkOutputSchema } from '../schemas/auth.ts';
import {
  LibrariesListOutputSchema,
  LibraryBrowseInputSchema,
  LibraryBrowseOutputSchema,
  LibraryCreateInputSchema,
  LibraryGetOutputSchema,
  LibraryIdInputSchema,
  LibrarySchema,
  LibraryUpdateInputSchema,
} from '../schemas/libraries.ts';
import {
  LibraryFileDetailSchema,
  LibraryFileInputSchema,
  LibraryFilesInputSchema,
  LibraryFilesOutputSchema,
  LibrarySeasonsInputSchema,
  LibrarySeasonsOutputSchema,
  LibraryTitlesInputSchema,
  LibraryTitlesOutputSchema,
} from '../schemas/library-files.ts';

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
    .output(LibraryGetOutputSchema),
  browse: oc
    .route({
      method: 'GET',
      path: '/libraries/{id}/browse',
      tags,
      summary: 'List the sub-folders and media files of a library folder',
    })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND', 'PATH_REJECTED', 'LIBRARY_UNREACHABLE') })
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
  titles: oc
    .route({
      method: 'GET',
      path: '/libraries/{id}/titles',
      tags,
      summary: 'List the shows and movies of a library',
    })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND') })
    .input(LibraryTitlesInputSchema)
    .output(LibraryTitlesOutputSchema),
  seasons: oc
    .route({
      method: 'GET',
      path: '/libraries/{id}/seasons',
      tags,
      summary: 'List the seasons of a show',
    })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND') })
    .input(LibrarySeasonsInputSchema)
    .output(LibrarySeasonsOutputSchema),
  files: oc
    .route({
      method: 'GET',
      path: '/libraries/{id}/files',
      tags,
      summary: 'List the files of a library, each with its latest job',
    })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND') })
    .input(LibraryFilesInputSchema)
    .output(LibraryFilesOutputSchema),
  file: oc
    .route({
      method: 'GET',
      path: '/libraries/{id}/files/{fileId}',
      tags,
      summary: 'Get one file with all its jobs',
    })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND') })
    .input(LibraryFileInputSchema)
    .output(LibraryFileDetailSchema),
};
