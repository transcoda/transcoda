---
type: fixed
---
With an Intel GPU, a video its decoder can't read (such as 4:2:2) now still encodes on that GPU instead of falling back to the CPU, and a job no longer waits for a GPU it can't use. The GPU order in Settings now lists only the GPUs that can encode. A custom workflow that sets `-hwaccel qsv` now decodes and encodes on the Intel GPU the job was given.
