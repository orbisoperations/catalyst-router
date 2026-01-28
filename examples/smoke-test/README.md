# Smoke Test

End-to-end test for `@catalyst/telemetry` and `@catalyst/sdk` with the observability stack.

## Prerequisites

Start the observability stack:

```bash
docker-compose -f docker-compose/docker-compose.observability.yaml up -d
```

## Run

```bash
bun run examples/smoke-test/index.ts
```

## Endpoints

| Endpoint            | Description                           |
| ------------------- | ------------------------------------- |
| `GET /health`       | Health check (not instrumented)       |
| `GET /hello`        | Simple JSON response                  |
| `GET /slow`         | 500ms delay with custom span          |
| `GET /user/:id`     | Path parameter (normalized in traces) |
| `GET /metrics-test` | Records custom metrics                |
| `GET /error`        | Throws error (captured in trace)      |

## Test It

```bash
# Health check
curl http://localhost:3000/health

# Generate traces
curl http://localhost:3000/hello
curl http://localhost:3000/slow
curl http://localhost:3000/user/123
curl http://localhost:3000/user/456

# Generate metrics
curl http://localhost:3000/metrics-test

# Generate error trace
curl http://localhost:3000/error
```

## View Telemetry

### Traces

1. Open Jaeger: http://localhost:16687
2. Select service: `smoke-test`
3. Click "Find Traces"

You should see:

- `HTTP GET /hello` — simple request
- `HTTP GET /slow` with child span `slow-operation`
- `HTTP GET /user/:id` — path normalized
- `HTTP GET /error` — error recorded

### Metrics

1. Open Prometheus: http://localhost:9091
2. Query: `smoke_test_requests_total`

### Logs

1. Open InfluxDB: http://localhost:8087
2. Login: `admin` / `adminpassword`
3. Data Explorer → bucket: `logs`
4. Filter: `service.name` = `smoke-test`

Logs include `trace_id` for correlation with Jaeger.

## What It Tests

- [x] `initTelemetry()` initialization
- [x] `CatalystService` bootstrap
- [x] `telemetryMiddleware` auto-instrumentation
- [x] `getLogger()` with trace correlation
- [x] `service.tracer` manual spans
- [x] `service.meter` custom metrics
- [x] Path normalization (`/user/:id`)
- [x] Error recording in spans
- [x] Graceful shutdown with `onShutdown`
