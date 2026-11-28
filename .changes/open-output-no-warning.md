---
type: fixed
---
The workflow editor no longer warns that a path never writes the result when a step leaves one output open beside a connected one, such as Check source's OK on a branch that only checks files, or anywhere below Already processed's Yes. A step with nothing connected at all is still warned about.
