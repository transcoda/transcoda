---
type: new
---
Damaged downloads can now be handled in the workflow. Every workflow gets a Render step; turn on its Quality check and a file whose source turns out to be damaged takes a new Damaged output instead of failing, where Sonarr or Radarr can replace it. The new Check source step reads a file once and sends damaged files the same way before any time is spent encoding.
