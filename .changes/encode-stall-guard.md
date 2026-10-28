---
type: improved
---
An encode that stops writing output is now stopped after an hour instead of running on and using more and more memory. If it never wrote anything, the job fails with a reason that explains why; if it stopped partway (for example a network share that hung), the job is tried again, on another GPU or in software when the GPU was encoding. Slow encodes keep writing output and are not affected; the limit can be changed or turned off with `TRANSCODA_ENCODE_STALL_MINUTES`.
