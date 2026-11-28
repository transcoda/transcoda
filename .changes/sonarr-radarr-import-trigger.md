---
type: new
---
Sonarr and Radarr can start a job the moment they import or upgrade a file: add a webhook in their Connect settings that points at Transcoda, with an API token as the password, and the file is queued at once instead of at the next library check. Only files inside a library are queued. The steps are in the plugins guide.
