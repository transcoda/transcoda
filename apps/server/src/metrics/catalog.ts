// Every metric `/metrics` serves, in the order it serves them. The docs (docs/metrics.md) and the
// Grafana dashboard (examples/grafana) are checked against this list by tests.
//
// Labels come only from small, fixed sets: library names, job states and outcomes, lanes, encode
// slots and GPUs. Never a path, a job id, a file or a failure message.

export interface MetricDef {
  name: string;
  type: 'gauge' | 'counter' | 'histogram';
  help: string;
  labels: readonly string[];
}

export const METRICS = [
  {
    name: 'transcoda_build_info',
    type: 'gauge',
    help: 'Always 1; the running Transcoda version is the label.',
    labels: ['version'],
  },
  {
    name: 'transcoda_queue_paused',
    type: 'gauge',
    help: '1 while the whole queue is paused, else 0.',
    labels: [],
  },
  {
    name: 'transcoda_jobs',
    type: 'gauge',
    help: 'Jobs not finished yet, by state and lane.',
    labels: ['library', 'state', 'lane'],
  },
  {
    name: 'transcoda_jobs_paused',
    type: 'gauge',
    help: 'Unfinished jobs that are paused one by one.',
    labels: ['library'],
  },
  {
    name: 'transcoda_jobs_finished',
    type: 'gauge',
    help: 'Finished jobs by outcome, all time.',
    labels: ['library', 'outcome'],
  },
  {
    name: 'transcoda_job_retries',
    type: 'gauge',
    help: 'Attempts beyond the first, summed over all jobs.',
    labels: ['library'],
  },
  {
    name: 'transcoda_source_bytes',
    type: 'gauge',
    help: 'Size of the originals of replaced files, restored ones left out.',
    labels: ['library'],
  },
  {
    name: 'transcoda_output_bytes',
    type: 'gauge',
    help: 'Size of the replacements of replaced files, restored ones left out.',
    labels: ['library'],
  },
  {
    name: 'transcoda_saved_bytes',
    type: 'gauge',
    help: 'Bytes saved by replaced files (source minus output), restored ones left out.',
    labels: ['library'],
  },
  {
    name: 'transcoda_processed_media_seconds',
    type: 'gauge',
    help: 'Duration of the videos encoded, replaced or kept original.',
    labels: ['library'],
  },
  {
    name: 'transcoda_job_duration_seconds',
    type: 'histogram',
    help: 'Start to finish of the jobs finished since the server started.',
    labels: ['lane', 'outcome'],
  },
  {
    name: 'transcoda_encoder_busy',
    type: 'gauge',
    help: '1 while the encode slot runs a job, else 0.',
    labels: ['encoder'],
  },
  {
    name: 'transcoda_encoder_busy_seconds_total',
    type: 'counter',
    help: 'Seconds the encode slot ran a job since the server started.',
    labels: ['encoder'],
  },
  {
    name: 'transcoda_gpu_utilization_ratio',
    type: 'gauge',
    help: "The GPU's video encoder or decoder load at the last sample (0 to 1).",
    labels: ['gpu', 'engine'],
  },
  {
    name: 'transcoda_recycle_bytes',
    type: 'gauge',
    help: 'Size of the files in the recycle folder.',
    labels: ['library'],
  },
  {
    name: 'transcoda_recycle_files',
    type: 'gauge',
    help: 'Files in the recycle folder.',
    labels: ['library'],
  },
  {
    name: 'transcoda_library_files',
    type: 'gauge',
    help: 'Files Transcoda has seen in the library.',
    labels: ['library'],
  },
  {
    name: 'transcoda_runs',
    type: 'gauge',
    help: 'Runs (scans) started, by what started them, all time.',
    labels: ['library', 'source'],
  },
  {
    name: 'transcoda_scratch_free_bytes',
    type: 'gauge',
    help: 'Free space on the transcode folder; absent when it cannot be read.',
    labels: [],
  },
] as const satisfies readonly MetricDef[];

export type MetricName = (typeof METRICS)[number]['name'];
