import type { Settings } from '@transcoda/contract';

/** A `settings.get` answer for the section tests: defaults everywhere, nothing set by env. */
export function settingsFixture(): Settings {
  return {
    general: {
      serverName: { value: null, default: null, source: { kind: 'default' } },
      theme: { value: 'system', default: 'system', source: { kind: 'default' } },
      publicUrl: { value: null, variable: 'TRANSCODA_PUBLIC_URL', set: false },
      allowedHosts: [
        { host: 'localhost', source: { kind: 'built-in' } },
        { host: 'nas.lan', source: { kind: 'setup' } },
        { host: 'media.example', source: { kind: 'env', variable: 'TRANSCODA_ALLOWED_HOSTS' } },
      ],
    },
    queue: {
      paused: false,
      lanes: [
        { id: 'encode', label: 'Encode' },
        { id: 'quick', label: 'Quick' },
      ],
      stallHours: { value: 6, variable: 'TRANSCODA_HEALTH_STALL_HOURS', set: false },
      minFreeGib: { value: 10, variable: 'TRANSCODA_HEALTH_MIN_FREE_GIB', set: true },
      testEncodeKeepHours: { value: 2, default: 2, source: { kind: 'default' } },
      encodeDevice: { value: 'auto', default: 'auto', source: { kind: 'default' } },
      encodeDevices: [
        { id: 'auto', label: 'Auto', missing: false },
        { id: 'cpu', label: 'CPU only', missing: false },
        { id: 'nvidia:0', label: 'GPU 0 · NVIDIA GeForce RTX 3060', missing: false },
      ],
      gpuOrder: { value: [], default: [], source: { kind: 'default' } },
      gpus: [],
      pinnedVendorWorkflows: [],
    },
    recycle: {
      retentionDays: { value: 7, default: 7, source: { kind: 'default' } },
      maxFreePercent: { value: 25, default: 25, source: { kind: 'default' } },
      usage: { files: 41, bytes: 12_300_000_000 },
    },
    plugins: {
      callTimeoutMs: { value: 30_000, default: 30_000, source: { kind: 'default' } },
      finishRunTimeoutMs: { value: 600_000, source: { kind: 'default' } },
      isolation: { mode: 'separate-user', variable: 'TRANSCODA_PLUGIN_ISOLATION' },
    },
    about: { version: '1.4.0', node: 'v24.22.0' },
  };
}
