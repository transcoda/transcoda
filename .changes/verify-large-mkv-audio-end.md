---
type: fixed
---
Verify no longer fails with "the end of source stream cannot be read" on large Matroska files. Reading the end of an audio track used to read the whole file from its start, which took longer than the verify time limit on a large remux.
