# Metrics: Prometheus, Grafana and Home Assistant

Transcoda serves its numbers in two forms:

- `GET /metrics` in the Prometheus text format, for Prometheus (and anything that reads it: VictoriaMetrics, Grafana Agent, Telegraf).
- `GET /api/v1/system/status` as a small JSON summary, for pollers that cannot read that format, such as Home Assistant's RESTful sensor.

Both are read-only and come from the same snapshot, taken at most once every 5 seconds: a scrape inside that window gets the last answer, so a short scrape interval cannot load the database. They carry counts, bytes, library names and encoder names, never a file path, a job, or a failure message.

## Access

Both need an API token with the **`metrics`** scope (or a signed-in browser session). Create one under **Settings → API tokens** with only that scope ticked. The `metrics` scope gives nothing else: no other API call, no MCP tool. Other scopes do not include it either, so a `read` token gets `403` from `/metrics`. The host check applies as for the API: the host name Prometheus uses must be allowed (see [`TRANSCODA_ALLOWED_HOSTS`](env.md#server)).

| Request | Answer |
|---|---|
| No credentials, or an unknown, expired or revoked token | `401`, with `WWW-Authenticate: Bearer realm="transcoda"` |
| A token without `metrics` | `403` |
| A host that is not allowed | `403` |
| `TRANSCODA_METRICS=false` | `404`, before any auth check |

Both endpoints are on by default; nothing is readable without such a token. To turn them off, set `TRANSCODA_METRICS=false` and restart (see [env.md](env.md#server)).

## Prometheus

Save the token in a file Prometheus can read (for example `/etc/prometheus/transcoda.token`) and add a job:

```yaml
scrape_configs:
  - job_name: transcoda
    scrape_interval: 30s
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/transcoda.token
    static_configs:
      - targets: ['transcoda:8080']
```

With Prometheus in another container, `transcoda` is the container name and must be in `TRANSCODA_ALLOWED_HOSTS`. Behind a reverse proxy, scrape the proxy's address and scheme instead (`scheme: https`).

These examples send the token over plain HTTP, which is fine on a host or a private container network. When the traffic crosses a network you don't trust, put Transcoda behind a reverse proxy with HTTPS, or anyone watching can copy the token and read your metrics and library names. The same applies to the Home Assistant example below.

Try it by hand:

```sh
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/metrics
```

## Grafana

Import [`examples/grafana/transcoda-dashboard.json`](../examples/grafana/transcoda-dashboard.json) (Dashboards → New → Import → upload the file) and pick your Prometheus data source when asked. It shows the queue, saved space, throughput (saved per day, jobs finished per hour, hours of video per day, encode speed), the encoders and GPUs, job durations, failures and retries, and per-library totals. A **Library** filter at the top narrows the library panels. Tested against Grafana 10 and newer.

## Metrics

All sizes are bytes (Grafana's `decbytes` unit shows them in SI units, 1 GB = 1,000,000,000 bytes). Totals that come from the database are gauges, not counters: they can go down (Restore original takes a file's saving back out; a deleted library drops out), so chart them with `delta()`, not `rate()` or `increase()`. The two metrics that are counted in memory since the server started (`transcoda_job_duration_seconds` and `transcoda_encoder_busy_seconds_total`) start again from zero at a restart, which `rate()` and `increase()` handle.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `transcoda_build_info` | gauge | `version` | Always 1; the running version is the label. |
| `transcoda_queue_paused` | gauge |  | 1 while the whole queue is paused, else 0. |
| `transcoda_jobs` | gauge | `library`, `state`, `lane` | Jobs not finished yet. `state`: `queued`, `probing`, `deciding`, `building`, `encoding`, `verifying`, `replacing`. `lane`: `encode`, `quick`, or empty before a job has one. Only combinations with at least one job are listed. |
| `transcoda_jobs_paused` | gauge | `library` | Unfinished jobs paused one by one. |
| `transcoda_jobs_finished` | gauge | `library`, `outcome` | Finished jobs, all time. `outcome`: `done` (replaced), `kept_original`, `nothing_to_do`, `failed`, `cancelled`, `dry_run`, `skipped`, `already_processed`. |
| `transcoda_job_retries` | gauge | `library` | Attempts beyond the first, summed over all jobs. |
| `transcoda_source_bytes` | gauge | `library` | Size of the originals of replaced files, restored ones left out. |
| `transcoda_output_bytes` | gauge | `library` | Size of their replacements. |
| `transcoda_saved_bytes` | gauge | `library` | Source minus output: the space saved. Matches "Saved all time" on the Jobs page. |
| `transcoda_processed_media_seconds` | gauge | `library` | Duration of the videos encoded, replaced or kept original. |
| `transcoda_job_duration_seconds` | histogram | `lane`, `outcome` | Start to finish of the jobs finished since the server started. Buckets from 10 seconds to 8 hours. |
| `transcoda_encoder_busy` | gauge | `encoder` | 1 while the encode slot runs a job. `encoder` is the slot: `encode` with one encoder, a GPU id (`nvidia:0`, `intel:…`) with several. |
| `transcoda_encoder_busy_seconds_total` | counter | `encoder` | Seconds the encode slot ran a job since the server started. |
| `transcoda_gpu_utilization_ratio` | gauge | `gpu`, `engine` | The GPU's video encoder or decoder load at the last sample, 0 to 1 (`engine`: `encoder`, `decoder`). The same readings as the Jobs page graph; absent without a GPU. |
| `transcoda_recycle_bytes` | gauge | `library` | Size of the files in the library's recycle folder. |
| `transcoda_recycle_files` | gauge | `library` | Files in the library's recycle folder. |
| `transcoda_library_files` | gauge | `library` | Files Transcoda has seen in the library. |
| `transcoda_runs` | gauge | `library`, `source` | Runs (scans) started, all time. `source`: `manual` or `library` (a watched folder or run hours). |
| `transcoda_scratch_free_bytes` | gauge |  | Free space on the transcode folder; absent when it cannot be read. |

`library` is the library's name. Two libraries with the same name get the first 8 characters of their id added (`Movies (3f2a91c0)`). Renaming a library starts new series under the new name. Deleted libraries are left out.

There is no per-file or per-job label and no failure reason: those would make a series per file. A job's details stay in the UI and the API.

Useful queries:

```promql
# Saved per day, per library
sum by (library) (delta(transcoda_saved_bytes[1d]))

# Encode speed over the last hour (1 = real time)
sum(delta(transcoda_processed_media_seconds[1h])) / sum(increase(transcoda_encoder_busy_seconds_total[1h]))

# Median encode-lane job duration over the last 6 hours
histogram_quantile(0.5, sum by (le) (increase(transcoda_job_duration_seconds_bucket{lane="encode"}[6h])))

# Alert: the queue has been paused for an hour
min_over_time(transcoda_queue_paused[1h]) == 1
```

## Status summary (Home Assistant)

`GET /api/v1/system/status` answers the same numbers summed up:

```json
{
  "version": "0.5.0",
  "queuePaused": false,
  "jobs": { "queued": 12, "running": 1, "paused": 0, "failed": 3, "finished": 418 },
  "encoders": { "busy": 1, "total": 1 },
  "savedBytes": 734000000000,
  "sourceBytes": 1912000000000,
  "outputBytes": 1178000000000,
  "recycleBytes": 41000000000,
  "recycleFiles": 17,
  "scratchFreeBytes": 220000000000,
  "libraries": [
    { "name": "Movies", "queued": 12, "running": 1, "savedBytes": 734000000000, "recycleBytes": 41000000000 }
  ]
}
```

`running` counts jobs probing through replacing; `failed` and `finished` are all time; `scratchFreeBytes` is `null` when the transcode folder cannot be read or does not answer within 2 seconds. The schema is in the OpenAPI spec (`/api/openapi.json`).

Home Assistant's built-in [RESTful integration](https://www.home-assistant.io/integrations/rest/) can poll it. In `configuration.yaml`, with the token in `secrets.yaml` as `tcd_status_auth: "Bearer tcd_…"`:

```yaml
rest:
  - resource: http://transcoda:8080/api/v1/system/status
    headers:
      Authorization: !secret tcd_status_auth
    scan_interval: 60
    sensor:
      - name: Transcoda queued
        value_template: "{{ value_json.jobs.queued }}"
        unit_of_measurement: jobs
      - name: Transcoda running
        value_template: "{{ value_json.jobs.running }}"
        unit_of_measurement: jobs
      - name: Transcoda saved
        value_template: "{{ (value_json.savedBytes / 1e9) | round(1) }}"
        unit_of_measurement: GB
        device_class: data_size
        state_class: total
      - name: Transcoda scratch free
        value_template: "{{ (value_json.scratchFreeBytes / 1e9) | round(1) if value_json.scratchFreeBytes is not none else none }}"
        unit_of_measurement: GB
        device_class: data_size
    binary_sensor:
      - name: Transcoda queue paused
        value_template: "{{ value_json.queuePaused }}"
```

The host Home Assistant uses (`transcoda` above) must be allowed, as for Prometheus. If you already run Prometheus, the community Prometheus sensor (HACS) can read `/metrics` instead.
