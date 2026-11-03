import { oc } from '@orpc/contract';
import { mutationErrors, pickErrors } from '../errors.ts';
import { RecycleRestoreInputSchema, RecycleRestoreOutputSchema } from '../schemas/recycle.ts';

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
};
