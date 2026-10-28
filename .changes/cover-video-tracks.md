---
type: fixed
---
A cover image stored as a video track (for example one an earlier conversion turned from an attachment into a one-frame video) is now copied instead of encoded. Encoding it held back the whole output, so a job could run for hours with an empty output file while ffmpeg used more and more memory. Turning off "Keep cover images" now removes these tracks too.
