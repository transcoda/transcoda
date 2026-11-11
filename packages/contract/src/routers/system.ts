import { oc } from '@orpc/contract';
import { authedErrors, mutationErrors, pickErrors } from '../errors.ts';
import { publicSpec } from '../openapi.ts';
import { LicencesOutputSchema } from '../schemas/licences.ts';
import {
  AppUpdateOutputSchema,
  BackupSchema,
  BackupsListOutputSchema,
  CapabilitiesSchema,
  GpuLoadOutputSchema,
  HealthInputSchema,
  HealthOutputSchema,
  StatusOutputSchema,
} from '../schemas/system.ts';

export const system = {
  health: oc
    .route({
      method: 'GET',
      path: '/system/health',
      tags: ['system'],
      summary: 'Health check',
      spec: publicSpec,
    })
    .input(HealthInputSchema)
    .errors(pickErrors('UNHEALTHY'))
    .output(HealthOutputSchema),
  capabilities: oc
    .route({
      method: 'GET',
      path: '/system/capabilities',
      tags: ['system'],
      summary: 'ffmpeg capabilities',
    })
    .errors(authedErrors)
    .output(CapabilitiesSchema),
  gpuLoad: oc
    .route({
      method: 'GET',
      path: '/system/gpu-load',
      tags: ['system'],
      summary: 'Video encoder and decoder load per NVIDIA GPU over the last hour',
    })
    .errors(authedErrors)
    .output(GpuLoadOutputSchema),
  /** Scope `metrics` (or a session); 404 when `TRANSCODA_METRICS=false`. */
  status: oc
    .route({
      method: 'GET',
      path: '/system/status',
      tags: ['system'],
      summary: 'Queue, jobs, encoders and bytes saved, summed up (for Home Assistant and the like)',
    })
    .errors(pickErrors('UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'))
    .output(StatusOutputSchema),
  update: oc
    .route({
      method: 'GET',
      path: '/system/update',
      tags: ['system'],
      summary: 'Whether a newer Transcoda release exists, with its release notes',
    })
    .errors(authedErrors)
    .output(AppUpdateOutputSchema),
  licences: oc
    .route({
      method: 'GET',
      path: '/system/licences',
      tags: ['system'],
      summary: 'Third-party components and their licenses',
    })
    .errors(authedErrors)
    .output(LicencesOutputSchema),
  backups: {
    list: oc
      .route({
        method: 'GET',
        path: '/system/backups',
        tags: ['system'],
        summary: 'Database backups (file names, sizes, times, reasons)',
      })
      .errors(authedErrors)
      .output(BackupsListOutputSchema),
    /** A person's browser session only: any API token is refused (FORBIDDEN), never an MCP tool. */
    create: oc
      .route({
        method: 'POST',
        path: '/system/backups',
        tags: ['system'],
        summary: 'Back up the database now (session only; at most one per 30 s)',
      })
      .errors({ ...mutationErrors, ...pickErrors('RATE_LIMITED') })
      .output(BackupSchema),
  },
};
