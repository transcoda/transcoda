---
type: fixed
---
Check source and verify no longer read a cover image stored as a video track. On such files (for example one an earlier conversion turned from an attachment into a video track) the check could use more and more memory until the server slowed to a crawl. As a safety net, these checks are now stopped if ffmpeg uses more than 4 GB of memory (or half of the container's memory, if that is less); the job then fails with a reason that says so, and the file is never marked as damaged. The limit can be changed or turned off with `TRANSCODA_DECODE_MEMORY_GB`.
