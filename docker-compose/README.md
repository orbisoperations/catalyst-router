# Observability Stack

Local observability infrastructure for Catalyst Node development.

## Components

| Service        | Port                     | Purpose                          | UI                     |
| -------------- | ------------------------ | -------------------------------- | ---------------------- |
| OTEL Collector | 4317 (gRPC), 4318 (HTTP) | Receives telemetry from services | -                      |
| Jaeger         | 16687                    | Distributed tracing              | http://localhost:16687 |
| Prometheus     | 9091                     | Metrics storage                  | http://localhost:9091  |
| InfluxDB       | 8087                     | Log storage                      | http://localhost:8087  |

## Quick Start

```bash
# Start the stack
docker-compose -f docker-compose/docker-compose.observability.yaml up -d

# Check status
docker-compose -f docker-compose/docker-compose.observability.yaml ps

# View logs
docker-compose -f docker-compose/docker-compose.observability.yaml logs -f

# Stop
docker-compose -f docker-compose/docker-compose.observability.yaml down
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Your Service                           │
│                                                             │
│   @catalyst/telemetry → OTLP HTTP → localhost:4318         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  OTEL Collector │
                    │   :4317/:4318   │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
   ┌──────────┐       ┌──────────┐       ┌──────────┐
   │  Jaeger  │       │Prometheus│       │ InfluxDB │
   │  :16687  │       │  :9091   │       │  :8087   │
   │ (traces) │       │ (metrics)│       │  (logs)  │
   └──────────┘       └──────────┘       └──────────┘
```

## Service Configuration

Configure your service to send telemetry to the collector:

```typescript
import { initTelemetry } from '@catalyst/telemetry'

await initTelemetry({
  serviceName: 'my-service',
  otlpEndpoint: 'http://localhost:4318',
})
```

Or via environment variable:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 bun run src/index.ts
```

## Viewing Telemetry

### Traces (Jaeger)

1. Open http://localhost:16687
2. Select your service from the dropdown
3. Click "Find Traces"
4. Click a trace to see the waterfall view

**Tips:**

- Filter by operation name, tags, or duration
- Use "Compare" to diff two traces
- Check "Dependencies" for service maps

### Metrics (Prometheus)

1. Open http://localhost:9091
2. Enter a PromQL query, e.g.:
   - `http_server_request_duration_seconds_bucket` — request latency histogram
   - `http_server_request_total` — request count by status
3. Click "Execute" → "Graph"

**Tips:**

- Use `rate()` for per-second rates: `rate(http_server_request_total[5m])`
- Use `histogram_quantile()` for percentiles

### Logs (InfluxDB)

1. Open http://localhost:8087
2. Login: `admin` / `adminpassword`
3. Go to "Data Explorer"
4. Select bucket: `logs`
5. Filter by `_measurement`, `service.name`, `severity`, etc.

**Tips:**

- Filter by trace_id to find logs for a specific request
- Use Flux queries for advanced filtering

## Files

| File                                                    | Purpose                  |
| ------------------------------------------------------- | ------------------------ |
| `docker-compose.observability.yaml`                     | Docker Compose config    |
| `prometheus.yaml`                                       | Prometheus scrape config |
| `../services/otel-collector/otel-collector-config.yaml` | Collector pipelines      |

## Customization

### Change Ports

Edit `docker-compose.observability.yaml`:

```yaml
services:
  jaeger:
    ports:
      - '16687:16686' # Change left side
```

### Add Sampling

Edit `services/otel-collector/otel-collector-config.yaml`:

```yaml
processors:
  probabilistic_sampler:
    sampling_percentage: 10

service:
  pipelines:
    traces:
      processors: [memory_limiter, probabilistic_sampler, batch]
```

### Persist Data

Data persists in Docker volumes:

- `prometheus-data` — Prometheus TSDB
- `influxdb-data` — InfluxDB data

To reset:

```bash
docker-compose -f docker-compose/docker-compose.observability.yaml down -v
```

## Troubleshooting

### Collector not starting

Check logs:

```bash
docker-compose -f docker-compose/docker-compose.observability.yaml logs otel-collector
```

Common issues:

- Invalid YAML in `otel-collector-config.yaml`
- Port conflicts

### No traces appearing

1. Verify collector is running: `docker ps | grep otel`
2. Check your service is sending to `http://localhost:4318`
3. Check collector logs for export errors

### Port conflicts

If ports are in use, edit the compose file to use different host ports:

```yaml
ports:
  - '16688:16686' # Map to different host port
```

## License Compliance

All components are Apache 2.0 or MIT licensed:

| Component        | License    |
| ---------------- | ---------- |
| OTEL Collector   | Apache 2.0 |
| Jaeger           | Apache 2.0 |
| Prometheus       | Apache 2.0 |
| InfluxDB 2.x OSS | MIT        |
