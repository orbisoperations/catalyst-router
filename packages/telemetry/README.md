# @catalyst/telemetry

Unified observability SDK for Catalyst services. Provides traces, logs, and metrics via OpenTelemetry with a single package import.

## Architecture

```
                        Catalyst Services
 ┌──────────────────────────────────────────────────────────┐
 │                                                          │
 │  ┌─────────┐      ┌─────────────┐      ┌────────────┐    │
 │  │  Auth   │      │   Gateway   │      │Orchestrator│    │
 │  │ :4001   │      │   :4000     │      │   :3000    │    │
 │  └────┬────┘      └─────┬───────┘      └─────┬──────┘    │
 │       │                 │                     │          │
 │       │    capnweb RPC + W3C traceparent      │          │
 │       │◄──────────────────────────────────────►          │
 │       │                 │                     │          │
 │  ┌────┴─────────────────┴─────────────────────┴────-──┐   │
 │  │              @catalyst/telemetry                   │   │
 │  │                                                    │   │
 │  │  instrumentation.ts   Manual NodeTracerProvider    │   │
 │  │  logger.ts            LogTape → pretty/JSON/OTLP   │   │
 │  │  metrics.ts           MeterProvider → OTLP         │   │
 │  │  capnweb.ts           Proxy-based RPC spans        │   │
 │  │  capnweb-transport.ts traceparent on WebSocket     │   │
 │  └───────────────────────┬────────────────────────────┘   │
 │                          │                                │
 │            OTLP/HTTP (traces, logs, metrics)              │
 │                          │                                │
 └──────────────────────────┼────────────────────────────────┘
                            │
                            ▼
 ┌──────────────────────────────────────────────────────────┐
 │                   OTel Collector :4318                   │
 │                                                          │
 │  receivers:    otlp (gRPC :4317, HTTP :4318)             │
 │  processors:   memory_limiter (256 MiB) → batch          │
 │                                                          │
 │  ┌─────────────────┬──────────────────┬────────────────┐ │
 │  │ traces pipeline │ metrics pipeline │ logs pipeline  │ │
 │  │                 │                  │                │ │
 │  │ debug (stdout)  │  debug (stdout)  │ debug (stdout) │ │
 │  └─────────────────┴──────────────────┴────────────────┘ │
 │                                                          │
 └──────────────────────────────────────────────────────────┘
```

## Signals

| Signal  | App-side SDK                                        | Collector exporter | Backend  |
| ------- | --------------------------------------------------- | ------------------ | -------- |
| Traces  | NodeTracerProvider + manual setup + RPC Proxy spans | `debug` (stdout)   | deferred |
| Logs    | LogTape → pretty (dev) / JSON (prod) / OTLP         | `debug` (stdout)   | deferred |
| Metrics | MeterProvider + PeriodicExportingMetricReader       | `debug` (stdout)   | deferred |

## Service integration

> **Note:** Services built on `@catalyst/service` get telemetry automatically via `CatalystService`. The manual setup below is only needed when using `@catalyst/telemetry` directly without the service base class.

Every service follows this initialization order:

```typescript
import {
  initTelemetry,
  getLogger,
  instrumentRpcTarget,
  shutdownTelemetry,
} from '@catalyst/telemetry'
// Hono middleware is a separate import — hono is an optional peer dependency
import { telemetryMiddleware } from '@catalyst/telemetry/middleware/hono'

// 1. Initialize all three signals (traces, metrics, logs)
await initTelemetry({
  serviceName: 'myservice',
  serviceVersion: '1.2.3',
  environment: 'production', // 'development' | 'production' | 'test'
  samplingRatio: 0.25, // optional trace sampling ratio (0.0 - 1.0)
})

// 2. Get a scoped logger
const logger = getLogger(['catalyst', 'myservice'])

// 3. Add HTTP telemetry middleware (requires hono)
app.use(telemetryMiddleware({ ignorePaths: ['/health'] }))

// 4. Wrap RPC targets for automatic span creation
const traced = instrumentRpcTarget(rpcServer, { serviceName: 'myservice' })

// 5. Graceful shutdown
process.on('SIGTERM', async () => {
  await shutdownTelemetry()
  process.exit(0)
})
```

> **Note:** If you call `shutdownMetrics()` directly instead of `shutdownTelemetry()`, also call `_resetMiddlewareCache()` (from `@catalyst/telemetry/middleware/hono`) before reconfiguring metrics. Otherwise the HTTP middleware continues recording on the stale meter provider.

For services that accept WebSocket RPC connections (orchestrator), also wrap the upgrade handler for cross-service trace propagation:

```typescript
import { instrumentPublicApi, instrumentUpgradeWebSocket } from '@catalyst/telemetry'

const instrumentedApi = instrumentPublicApi(bus, 'orchestrator')
const tracedUpgrade = instrumentUpgradeWebSocket(upgradeWebSocket)

app.all('/rpc', (c) =>
  newRpcResponse(c, instrumentedApi, {
    upgradeWebSocket: tracedUpgrade,
  })
)
```

## Cross-service trace propagation

Traces propagate across WebSocket RPC calls by prefixing each message with a W3C `traceparent`:

```
Wire format:
  00-<traceId>-<spanId>-01\n["push",["pipeline",0,["method"],args...]]

Without trace context (backward-compatible):
  ["push",["pipeline",0,["method"],args...]]
```

The `createTracePropagatingTransport` wrapper handles injection (client-side) and `instrumentUpgradeWebSocket` handles extraction (server-side). This creates linked CLIENT and SERVER spans across services without any changes to capnweb's RPC interface.

When tracing is enabled (OTLP endpoint set), spans are exported via OTLP/HTTP. If `OTEL_EXPORTER_OTLP_ENDPOINT` is missing, tracing is disabled and a warning is logged at startup.

Note: `WebSocketTransportAdapter.receive()` does not support concurrent calls; a second pending receive will throw until the first completes.

## Log sinks

The logger selects sinks based on environment:

| `NODE_ENV`    | OTLP endpoint set? | Active sinks          |
| ------------- | ------------------ | --------------------- |
| `development` | no                 | pretty (ANSI console) |
| `development` | yes                | pretty + OTLP         |
| `production`  | no                 | JSON (stdout)         |
| `production`  | yes                | JSON + OTLP           |
| `test`        | either             | pretty only           |

In production with OTLP, every log record is written to both stdout (for `docker logs`) and the collector (for centralized querying). The OTLP sink also injects `trace_id` and `span_id` from the active span context for log-trace correlation.

## Environment variables

| Variable                      | Used by                          | Default                                   |
| ----------------------------- | -------------------------------- | ----------------------------------------- |
| `OTEL_SERVICE_NAME`           | instrumentation, logger, metrics | `'catalyst'`                              |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | logger (OTLP sink), metrics      | none (sinks disabled)                     |
| `OTEL_SERVICE_VERSION`        | logger, metrics, traces          | `'0.0.0'`                                 |
| `OTEL_TRACES_SAMPLER_ARG`     | tracer                           | none (defaults to parent-based always-on) |
| `OTEL_SERVICE_INSTANCE_ID`    | all signals                      | `HOSTNAME`                                |
| `LOG_LEVEL`                   | logger                           | `'info'`                                  |
| `NODE_ENV`                    | logger (sink selection)          | `'development'`                           |

## Silent no-op behavior

When `OTEL_EXPORTER_OTLP_ENDPOINT` is **not set**, traces, metrics, and the OTLP log sink are all silently disabled. `initTelemetry()` succeeds but the underlying providers are never created. Calls to `getTracer()`, `getMeter()`, and `getLogger()` still return valid objects — they just produce no-op spans, no-op instruments, and local-only logs respectively.

This is by design: services run without an OTel Collector during development and in CI. If you expect telemetry data and see none, check that `OTEL_EXPORTER_OTLP_ENDPOINT` is set (e.g., `http://localhost:4318`).

## Running the collector locally

```bash
docker compose -f docker-compose/docker.compose.yaml up
```

Starts the OTel Collector (`:4317`/`:4318`). All three signals (traces, metrics, logs) print to collector stdout via the `debug` exporter. Backends (Jaeger, Prometheus, etc.) get wired later per ADR-0003.

## Module map

```
packages/telemetry/
├── src/
│   ├── index.ts                 barrel exports + initTelemetry/shutdownTelemetry
│   ├── instrumentation.ts       manual NodeTracerProvider setup (no side effects)
│   ├── logger.ts                LogTape config, pretty/JSON/OTLP sinks
│   ├── metrics.ts               MeterProvider + PeriodicExportingMetricReader
│   ├── resource.ts              shared OTel Resource builder (service name/version/env)
│   ├── constants.ts             shared constants (DURATION_BUCKETS, EXPORT_TIMEOUT_MS)
│   └── middleware/
│       ├── hono.ts              HTTP telemetry middleware (spans + metrics)
│       ├── capnweb.ts           Proxy-based RPC span instrumentation
│       └── capnweb-transport.ts W3C traceparent injection/extraction on WebSocket
└── tests/
    ├── index.test.ts
    ├── logger.test.ts
    ├── metrics.test.ts
    ├── normalize.test.ts
    ├── hono.test.ts
    ├── capnweb.test.ts
    └── capnweb-transport.test.ts
```
