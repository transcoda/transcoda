import { oc } from '@orpc/contract';
import { authedErrors, mutationErrors, pickErrors } from '../errors.ts';
import {
  RecycleDeleteInputSchema,
  RecycleDeleteOutputSchema,
  RecycleEmptyInputSchema,
  RecycleEmptyOutputSchema,
  RecycleListInputSchema,
  RecycleListOutputSchema,
  RecycleRestoreInputSchema,
  RecycleRestoreOutputSchema,
} from '../schemas/recycle.ts';

const tags = ['recycle'];

export const recycle = {
  restore: oc
    .route({
      method: 'POST',
      path: '/recycle/restore',
      tags,
      summary: "Put a recycled original back over its job's output, or undo that",
      description:
        "A person's session only. `path` is a recycle folder entry: a replaced original is restored (the output moves to the recycle folder, the job's recycled subtitle files come back), and the output a restore set aside is put back (the original and its subtitle files are recycled again). RECYCLE_REFUSED says why when the files on disk don't allow it; nothing has moved then.",
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND', 'RECYCLE_REFUSED') })
    .input(RecycleRestoreInputSchema)
    .output(RecycleRestoreOutputSchema),
  list: oc
    .route({
      method: 'GET',
      path: '/recycle',
      tags,
      summary: "Every library's recycle folder totals, and one library's entries",
      description:
        'Without libraryId, the entries are those of the first library whose recycle folder holds anything (else the first library). NOT_FOUND for an unknown libraryId.',
    })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND') })
    .input(RecycleListInputSchema)
    .output(RecycleListOutputSchema),
  delete: oc
    .route({
      method: 'POST',
      path: '/recycle/delete',
      tags,
      summary: 'Delete one recycle folder entry for good',
      description:
        "A person's session only. RECYCLE_REFUSED while a replace or restore of the entry's job is under way.",
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND', 'RECYCLE_REFUSED') })
    .input(RecycleDeleteInputSchema)
    .output(RecycleDeleteOutputSchema),
  empty: oc
    .route({
      method: 'POST',
      path: '/recycle/empty',
      tags,
      summary: "Delete a library's recycle folder entries for good",
      description:
        "A person's session only. Removes the entries recycled at or before throughRecycledAt (what was confirmed); entries whose job has a replace or restore under way are skipped and counted.",
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND') })
    .input(RecycleEmptyInputSchema)
    .output(RecycleEmptyOutputSchema),
};
