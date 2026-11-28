---
type: new
---
Errors in the web UI are now written to the Transcoda server's log and counted in the metrics (`transcoda_client_errors_total`), so you can see when a page fails. Reports go only to your own server, with file paths, titles and names taken out.
