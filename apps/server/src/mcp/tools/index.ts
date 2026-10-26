import type { AnyToolDef } from '../tool.ts';
import { jobTools } from './jobs.ts';
import { libraryTools } from './library.ts';
import { pluginTools } from './plugins.ts';
import { queueTools } from './queue.ts';
import { workflowReadTools } from './workflows-read.ts';
import { workflowWriteTools } from './workflows-write.ts';

/** Every tool the endpoint can offer; a token sees the ones its scopes allow. */
export const ALL_TOOLS: AnyToolDef[] = [
  ...queueTools,
  ...jobTools,
  ...workflowReadTools,
  ...workflowWriteTools,
  ...libraryTools,
  ...pluginTools,
];
