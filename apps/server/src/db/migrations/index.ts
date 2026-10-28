import type { Migration } from '../migrate.ts';
import { initial } from './0001_initial.ts';
import { workflows } from './0002_workflows.ts';
import { engine } from './0003_engine.ts';
import { jobProbe } from './0004_job_probe.ts';
import { activation } from './0005_activation.ts';
import { plugins } from './0006_plugins.ts';
import { signingBlocklist } from './0007_signing_blocklist.ts';
import { libraryTrigger } from './0008_library_trigger.ts';
import { testEncode } from './0009_test_encode.ts';
import { outputProbe } from './0010_output_probe.ts';
import { runHours } from './0011_run_hours.ts';
import { pluginStartAttempts } from './0012_plugin_start_attempts.ts';
import { gpuFields } from './0013_gpu_fields.ts';
import { sourceDamaged } from './0014_source_damaged.ts';
import { outputFingerprint } from './0015_output_fingerprint.ts';

export const migrations: Migration[] = [
  initial,
  workflows,
  engine,
  jobProbe,
  activation,
  plugins,
  signingBlocklist,
  libraryTrigger,
  testEncode,
  outputProbe,
  runHours,
  pluginStartAttempts,
  gpuFields,
  sourceDamaged,
  outputFingerprint,
];
