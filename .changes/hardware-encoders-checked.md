---
type: fixed
---
Transcoda no longer tries GPU encoders that can't run on your machine, such as NVIDIA's on a server without an NVIDIA GPU or Intel's when no GPU is passed into the container. Jobs encode in software from the start instead of failing over on every file.
