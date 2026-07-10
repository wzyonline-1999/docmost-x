# Docmost MCP monitoring

Prometheus scrapes `GET /api/mcp/metrics` with the bearer token configured in
`MCP_METRICS_TOKEN`. Keep this endpoint behind the reverse proxy allowlist when
possible; the application also rejects missing or invalid bearer tokens.

Example scrape job:

```yaml
- job_name: docmost-mcp
  metrics_path: /api/mcp/metrics
  authorization:
    type: Bearer
    credentials: ${MCP_METRICS_TOKEN}
  static_configs:
    - targets: [docmost:3000]
```

Load `mcp-alerts.yml` as a Prometheus rule file and import
`grafana/docmost-mcp-dashboard.json` into Grafana. Alert thresholds are release
defaults and should be tuned after the non-sensitive canary workspace produces
at least one week of baseline traffic.
