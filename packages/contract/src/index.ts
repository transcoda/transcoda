import type { ContractRouterClient } from '@orpc/contract';
import { auth } from './routers/auth.ts';
import { events } from './routers/events.ts';
import { fs } from './routers/fs.ts';
import { jobs } from './routers/jobs.ts';
import { libraries } from './routers/libraries.ts';
import { nodes } from './routers/nodes.ts';
import { plugins } from './routers/plugins.ts';
import { queue } from './routers/queue.ts';
import { runs } from './routers/runs.ts';
import { settings } from './routers/settings.ts';
import { system } from './routers/system.ts';
import { tokens } from './routers/tokens.ts';
import { workflows } from './routers/workflows.ts';

export const contract = {
  system,
  settings,
  auth,
  tokens,
  nodes,
  workflows,
  libraries,
  jobs,
  queue,
  runs,
  events,
  plugins,
  fs,
};
export type Contract = typeof contract;
export type ApiClient = ContractRouterClient<Contract>;

export { type ErrorCode, errorDefs } from './errors.ts';
export * from './schemas/auth.ts';
export * from './schemas/events.ts';
export * from './schemas/fs.ts';
export * from './schemas/jobs.ts';
export * from './schemas/libraries.ts';
export * from './schemas/licences.ts';
export * from './schemas/nodes.ts';
export * from './schemas/plugins.ts';
export * from './schemas/queue.ts';
export * from './schemas/runs.ts';
export * from './schemas/settings.ts';
export * from './schemas/system.ts';
export * from './schemas/tokens.ts';
export * from './schemas/user.ts';
export * from './schemas/workflows.ts';
