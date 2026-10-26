import { oc } from '@orpc/contract';
import { authedErrors, mutationErrors, pickErrors } from '../errors.ts';
import { OkOutputSchema } from '../schemas/auth.ts';
import {
  WorkflowActivateInputSchema,
  WorkflowCreateInputSchema,
  WorkflowDetailSchema,
  WorkflowDuplicateInputSchema,
  WorkflowDuplicateOutputSchema,
  WorkflowGetInputSchema,
  WorkflowIdInputSchema,
  WorkflowRenameInputSchema,
  WorkflowSaveInputSchema,
  WorkflowSaveOutputSchema,
  WorkflowSummarySchema,
  WorkflowsListOutputSchema,
  WorkflowValidateInputSchema,
  WorkflowValidateOutputSchema,
  WorkflowVersionsOutputSchema,
} from '../schemas/workflows.ts';

export const workflows = {
  list: oc
    .route({ method: 'GET', path: '/workflows', tags: ['workflows'], summary: 'List workflows' })
    .errors(authedErrors)
    .output(WorkflowsListOutputSchema),
  get: oc
    .route({
      method: 'GET',
      path: '/workflows/{id}',
      tags: ['workflows'],
      summary: 'Get a workflow (optionally a past version)',
    })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND') })
    .input(WorkflowGetInputSchema)
    .output(WorkflowDetailSchema),
  create: oc
    .route({
      method: 'POST',
      path: '/workflows',
      tags: ['workflows'],
      summary: 'Create a workflow',
    })
    .errors({ ...mutationErrors, ...pickErrors('KIND_MISMATCH', 'HIDDEN_URL_UNKNOWN') })
    .input(WorkflowCreateInputSchema)
    .output(WorkflowDetailSchema),
  save: oc
    .route({
      method: 'PUT',
      path: '/workflows/{id}',
      tags: ['workflows'],
      summary: 'Save a new version of a workflow',
    })
    .errors({
      ...mutationErrors,
      ...pickErrors('NOT_FOUND', 'VERSION_CONFLICT', 'KIND_MISMATCH', 'HIDDEN_URL_UNKNOWN'),
    })
    .input(WorkflowSaveInputSchema)
    .output(WorkflowSaveOutputSchema),
  validate: oc
    .route({
      method: 'POST',
      path: '/workflows/validate',
      tags: ['workflows'],
      summary: 'Validate a graph without saving it',
    })
    .errors(authedErrors)
    .input(WorkflowValidateInputSchema)
    .output(WorkflowValidateOutputSchema),
  activate: oc
    .route({
      method: 'POST',
      path: '/workflows/{id}/activate',
      tags: ['workflows'],
      summary: 'Activate a version: real runs use it from now on (session only)',
    })
    .errors({
      ...mutationErrors,
      ...pickErrors(
        'NOT_FOUND',
        'KIND_MISMATCH',
        'WORKFLOW_INVALID',
        'LIBRARY_TAKEN',
        'LIBRARY_MISSING',
      ),
    })
    .input(WorkflowActivateInputSchema)
    .output(WorkflowSummarySchema),
  deactivate: oc
    .route({
      method: 'POST',
      path: '/workflows/{id}/deactivate',
      tags: ['workflows'],
      summary: 'Deactivate: no version runs for real until one is activated (session only)',
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND', 'KIND_MISMATCH') })
    .input(WorkflowIdInputSchema)
    .output(WorkflowSummarySchema),
  rename: oc
    .route({
      method: 'PATCH',
      path: '/workflows/{id}',
      tags: ['workflows'],
      summary: 'Rename a workflow',
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND') })
    .input(WorkflowRenameInputSchema)
    .output(WorkflowSummarySchema),
  delete: oc
    .route({
      method: 'DELETE',
      path: '/workflows/{id}',
      tags: ['workflows'],
      summary: 'Delete a workflow',
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND', 'IN_USE') })
    .input(WorkflowIdInputSchema)
    .output(OkOutputSchema),
  versions: oc
    .route({
      method: 'GET',
      path: '/workflows/{id}/versions',
      tags: ['workflows'],
      summary: 'List the versions of a workflow',
    })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND') })
    .input(WorkflowIdInputSchema)
    .output(WorkflowVersionsOutputSchema),
  duplicate: oc
    .route({
      method: 'POST',
      path: '/workflows/{id}/duplicate',
      tags: ['workflows'],
      summary: 'Copy a workflow under a new name (webhook URLs are not copied)',
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND') })
    .input(WorkflowDuplicateInputSchema)
    .output(WorkflowDuplicateOutputSchema),
};
