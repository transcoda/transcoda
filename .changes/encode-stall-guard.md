---
type: improved
---
An encode that stops writing output is now stopped after an hour instead of running on and using more and more memory. The job fails with a reason that says what happened. Slow encodes keep writing output and are not affected; the limit can be changed or turned off with `TRANSCODA_ENCODE_STALL_MINUTES`.
