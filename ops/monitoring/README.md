# Docmost MCP monitoring

Prometheus scrapes `GET /api/mcp/metrics` with the bearer token configured in
`MCP_METRICS_TOKEN`. Keep this endpoint on a private network when possible; the
application also rejects missing or invalid bearer tokens.

Mount the token into Prometheus as a read-only credentials file. Do not place
the token directly in `prometheus.yml`, and do not rely on environment variable
expansion in that file.

Example scrape job:

```yaml
- job_name: docmost-mcp
  metrics_path: /api/mcp/metrics
  authorization:
    type: Bearer
    credentials_file: /run/secrets/docmost_mcp_metrics_token
  static_configs:
    - targets: [docmost:3000]
```

The Prometheus process must be able to read the mounted file. For a container
running as UID/GID `65534`, a root-owned file with group `65534` and mode `0640`
keeps the credential unavailable to other host users while remaining readable
inside the container.

Load `mcp-alerts.yml` as a Prometheus rule file and import
`grafana/docmost-mcp-dashboard.json` into Grafana. Alert thresholds are release
defaults and should be tuned after the non-sensitive canary workspace produces
at least one week of baseline traffic.

For multi-replica deployments, scrape every application replica. Request
counters and histograms are summed across replicas. Database-backed gauges use
a Redis-coordinated shared snapshot, and the supplied dashboard and alerts use
`max by (status)` so that identical snapshots are not counted once per replica.
