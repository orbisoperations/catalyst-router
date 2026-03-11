# Aspire Dashboard for OTel Compliance Verification

## Context

PR review feedback asked to "try a new UI to make sure we're following OTel." The current observability stack (Grafana + Loki/Prometheus/Jaeger) works but Grafana isn't OTel-native — it's a general-purpose dashboard that queries various backends. An OTel-native UI would surface attribute naming issues that Grafana might mask.

## Decision

Add the .NET Aspire Dashboard as an opt-in Docker Compose profile. Aspire accepts OTLP directly, stores in-memory, and renders all three signals (logs, metrics, traces) in an OTel-native UI. It's the least-coupled option — a single container bolted onto the existing stack with no backend changes.

Alternatives considered:

- **SigNoz** — full OTel-native platform, but requires swapping the entire backend (ClickHouse replaces Loki/Prometheus/Jaeger)
- **Uptrace** — similar to SigNoz, BSL license concern
- **VictoriaMetrics / InfluxDB** — storage engines, still use Grafana for UI

## Architecture

```
Catalyst Services → OTel Collector → Loki/Prometheus/Jaeger → Grafana (always)
                                   ↘ Aspire Dashboard (when --profile aspire)
```

- Existing stack unchanged
- Aspire Dashboard added as a compose profile (`aspire`)
- Collector gets one additional exporter (`otlphttp/aspire`) wired into all three pipelines
- When profile is inactive, the exporter silently fails (no impact)

## Changes

### `docker-compose/docker.compose.yaml`

Add service:

```yaml
aspire-dashboard:
  image: mcr.microsoft.com/dotnet/aspire-dashboard:latest
  container_name: catalyst-aspire-dashboard
  ports:
    - '18888:18888'
  environment:
    - DOTNET_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=true
    - OTEL_EXPORTER_OTLP_ENDPOINT=http://aspire-dashboard:18889
  profiles:
    - aspire
```

### `docker-compose/otel-collector-config.yaml`

Add exporter:

```yaml
exporters:
  otlphttp/aspire:
    endpoint: http://aspire-dashboard:18889
```

Add to all three pipelines:

```yaml
pipelines:
  traces:
    exporters: [debug, otlphttp/jaeger, otlphttp/aspire]
  metrics:
    exporters: [debug, prometheusremotewrite, otlphttp/aspire]
  logs:
    exporters: [debug, otlphttp/loki, otlphttp/aspire]
```

## Usage

```bash
# Normal (Grafana stack only):
docker compose -f docker-compose/docker.compose.yaml up

# With Aspire Dashboard:
docker compose -f docker-compose/docker.compose.yaml --profile aspire up
```

Aspire UI: `http://localhost:18888`

## Verification Checklist

Once running with the `aspire` profile:

- [ ] `catalyst.event.outcome` and `catalyst.event.duration_ms` render as structured log attributes
- [ ] `catalyst.orchestrator.*` attributes appear on orchestrator log records
- [ ] Standard OTel attributes (`exception.*`, `http.*`, `event.name`) display correctly
- [ ] Traces show proper span attributes and hierarchy
- [ ] Metrics appear with expected names and labels

## Constraints

- Aspire stores data in-memory — no persistence across restarts
- Limited querying compared to Grafana — this is a verification tool, not a replacement
- MIT licensed (.NET Foundation)
