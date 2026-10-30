---
type: improved
---
Every Docker image now comes with a signed record of how it was built and a list of its packages, so you can check that it really came from the Transcoda repository: `gh attestation verify oci://ghcr.io/transcoda/transcoda:latest --repo transcoda/transcoda`. Release pages carry both as files too.
