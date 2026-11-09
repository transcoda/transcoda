---
type: improved
---
Every size in Transcoda now uses the same decimal units (1 GB = 1,000,000,000 bytes): Settings shows the minimum free space as "5.00 GB" instead of GiB, and the File matches step reads its MB values the same way. Set the minimum free space with the new `TRANSCODA_HEALTH_MIN_FREE_GB`; the older `TRANSCODA_HEALTH_MIN_FREE_GIB` still works. The default margins are now 5 GB instead of 5 GiB.
