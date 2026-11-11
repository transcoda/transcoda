---
type: new
---
Chart Transcoda in Grafana: the server now serves Prometheus metrics at `/metrics` (queue, jobs by state and outcome, space saved per library, hours of video encoded, encoder and GPU load, recycle folder size), and a ready-made Grafana dashboard is in `examples/grafana`. Create an API token with the new `metrics` scope for Prometheus to read it; set `TRANSCODA_METRICS=false` to turn it off.
