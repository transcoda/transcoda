import { QueueStatusSchema } from '@transcoda/contract';
import { JobStateSchema, RUNNING_JOB_STATES } from '@transcoda/shared';
import { z } from 'zod';
import { type AnyToolDef, defineTool } from '../tool.ts';

const queueStatus = defineTool({
  name: 'queue_status',
  title: 'Queue status',
  description:
    'Whether the queue is paused, which job holds each lane, the jobs being prepared, and the number of jobs in every state.',
  scopes: ['read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: {},
  output: {
    ...QueueStatusSchema.shape,
    counts: z.record(JobStateSchema, z.number().int()).describe('Jobs per state'),
  },
  async run({ api }) {
    const [status, { counts }] = await Promise.all([
      api.queue.status(),
      api.jobs.list({ limit: 1 }),
    ]);
    const running = RUNNING_JOB_STATES.reduce((sum, state) => sum + (counts[state] ?? 0), 0);
    const { paused, lanes, encodeSlots, preparing } = status;
    // One slot reads as before; several (one per GPU) are listed by name.
    const encode =
      encodeSlots.length > 1
        ? encodeSlots.map((s) => `${s.label}: ${s.jobId ?? 'idle'}`).join(', ')
        : `encode lane: ${lanes.encode ?? 'idle'}`;
    return {
      text:
        `Queue ${paused ? 'paused' : 'running'}; ${encode}; ` +
        `quick lane: ${lanes.quick ?? 'idle'}; preparing ${preparing.length}; ` +
        `queued ${counts.queued ?? 0}, running ${running}, failed ${counts.failed ?? 0}`,
      data: { ...status, counts },
    };
  },
});

const pauseQueue = defineTool({
  name: 'pause_queue',
  title: 'Pause the queue',
  description:
    'Pause the queue: running jobs are frozen and nothing new starts. Persists across restarts.',
  scopes: ['jobs:manage'],
  annotations: { idempotentHint: true, openWorldHint: false },
  input: {},
  output: QueueStatusSchema.shape,
  async run({ api }) {
    return { text: 'Queue paused.', data: await api.queue.pause() };
  },
});

const resumeQueue = defineTool({
  name: 'resume_queue',
  title: 'Resume the queue',
  description: 'Resume a paused queue.',
  scopes: ['jobs:manage'],
  annotations: { idempotentHint: true, openWorldHint: false },
  input: {},
  output: QueueStatusSchema.shape,
  async run({ api }) {
    return { text: 'Queue resumed.', data: await api.queue.resume() };
  },
});

export const queueTools: AnyToolDef[] = [queueStatus, pauseQueue, resumeQueue];
