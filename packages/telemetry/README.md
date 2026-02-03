# @catalyst/telemetry

Unified OpenTelemetry instrumentation for Catalyst Node services. Provides traces, metrics, and structured logging with automatic correlation.

## Installation

```bash
bun add @catalyst/telemetry
```

## Quick Start

```typescript
import { initTelemetry, getLogger, getTracer, getMeter, shutdown } from '@catalyst/telemetry'

// Initialize FIRST, before other imports
await initTelemetry({
  serviceName: 'my-service',
  serviceVersion: '1.0.0',
  environment: process.env.NODE_ENV ?? 'development',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
})

// Get instrumentation primitives
const logger = getLogger('my-service')
const tracer = getTracer('my-service')
const meter = getMeter('my-service')

// Use them
logger.info`Server starting on port 3000`

const span = tracer.startSpan('process-request')
// ... do work
span.end()

const counter = meter.createCounter('requests.total')
counter.add(1, { endpoint: '/api' })

// Graceful shutdown (flushes all telemetry)
process.on('SIGTERM', async () => {
  await shutdown()
  process.exit(0)
})
```

## Configuration

### `initTelemetry(options)`

| Option                       | Type                                        | Default                   | Description                    |
| ---------------------------- | ------------------------------------------- | ------------------------- | ------------------------------ |
| `serviceName`                | `string`                                    | **required**              | Service name for OTEL resource |
| `serviceVersion`             | `string`                                    | `"0.0.0"`                 | Service version                |
| `environment`                | `string`                                    | `"development"`           | Deployment environment         |
| `otlpEndpoint`               | `string`                                    | `"http://localhost:4318"` | OTLP HTTP endpoint             |
| `logLevel`                   | `"debug" \| "info" \| "warning" \| "error"` | `"info"`                  | Minimum log level              |
| `enableConsole`              | `boolean`                                   | `true`                    | Enable console log output      |
| `batch`                      | `BatchConfig`                               | see below                 | Trace batch processor config   |
| `metricExportIntervalMillis` | `number`                                    | `60000`                   | Metrics export interval        |

### `BatchConfig`

| Option                 | Type     | Default | Description          |
| ---------------------- | -------- | ------- | -------------------- |
| `maxQueueSize`         | `number` | `2048`  | Max spans in queue   |
| `maxExportBatchSize`   | `number` | `512`   | Max spans per export |
| `scheduledDelayMillis` | `number` | `5000`  | Export interval      |

## Logging

Uses [LogTape](https://logtape.org) for structured logging with automatic trace correlation.

```typescript
import { getLogger } from '@catalyst/telemetry'

const logger = getLogger('my-service', 'subsystem')

// Template literal syntax (recommended)
logger.info`User ${userId} logged in`
logger.error`Failed to process order ${orderId}: ${error.message}`

// With structured properties
logger.info('Request processed', {
  userId,
  duration: 150,
  endpoint: '/api/users',
})
```

Logs automatically include `trace_id` and `span_id` when emitted within an active span context.

## Tracing

```typescript
import { getTracer, SpanStatusCode } from '@catalyst/telemetry'

const tracer = getTracer('my-service')

// Manual spans
const span = tracer.startSpan('operation-name', {
  attributes: {
    'user.id': userId,
    'operation.type': 'query',
  },
})

try {
  const result = await doWork()
  span.setStatus({ code: SpanStatusCode.OK })
  return result
} catch (error) {
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
  span.recordException(error)
  throw error
} finally {
  span.end()
}
```

## Metrics

```typescript
import { getMeter } from '@catalyst/telemetry'

const meter = getMeter('my-service')

// Counter
const requestCounter = meter.createCounter('http.requests.total', {
  description: 'Total HTTP requests',
})
requestCounter.add(1, { method: 'GET', status: 200 })

// Histogram
const latencyHistogram = meter.createHistogram('http.request.duration', {
  description: 'Request duration in milliseconds',
  unit: 'ms',
})
latencyHistogram.record(42, { endpoint: '/api/users' })

// Observable gauge
meter.createObservableGauge(
  'system.memory.usage',
  {
    description: 'Memory usage in bytes',
  },
  (result) => {
    result.observe(process.memoryUsage().heapUsed)
  }
)
```

## HTTP Middleware (Hono)

Auto-instruments HTTP requests with spans and metrics.

```typescript
import { Hono } from 'hono'
import { telemetryMiddleware } from '@catalyst/telemetry/middleware/hono'

const app = new Hono()

app.use(
  '*',
  telemetryMiddleware({
    ignorePaths: ['/health', '/ready'], // Skip instrumentation
    spanNamePrefix: 'HTTP', // Span name prefix
  })
)

app.get('/api/users', (c) => c.json({ users: [] }))
```

**Spans** — Each request creates a span with:

- `http.request.method`
- `http.route`
- `http.response.status_code`
- `url.path`

**Metrics** — Records `http.server.request.duration` histogram (seconds) with:

- `http.request.method`
- `http.route`
- `http.response.status_code`
- `url.scheme`
- `error.type` (on 4xx/5xx responses)

The histogram's internal `_count` provides request totals in Prometheus.

## GraphQL Middleware (Yoga)

Instruments GraphQL operations with resolver-level tracing.

```typescript
import { createYoga } from 'graphql-yoga'
import { createYogaTelemetryPlugin } from '@catalyst/telemetry/middleware/yoga'

const yoga = createYoga({
  schema,
  plugins: [
    createYogaTelemetryPlugin({
      resolvers: true, // Trace individual resolvers
      variables: false, // Don't log variables (may contain PII)
      result: false, // Don't log results
    }),
  ],
})
```

**Important**: Call `initTelemetry()` before creating the Yoga instance.

## RPC Middleware (capnweb)

Instruments RPC method calls via a Proxy wrapper.

```typescript
import { instrumentRpcTarget } from '@catalyst/telemetry/middleware/capnweb'

// Your RPC handler object
const authService = {
  async login(username: string, password: string) {
    // ... implementation
    return { success: true, token: '...' }
  },
  async logout(token: string) {
    return { success: true }
  },
}

// Wrap with instrumentation
const instrumentedService = instrumentRpcTarget(authService, {
  serviceName: 'auth', // Required: prefix for span names
  recordArguments: false, // Optional: log args (PII-sanitized)
})
```

Each RPC call creates a span with:

- `rpc.system.name`: `"capnweb"`
- `rpc.method`: Method name (e.g., `"login"`)
- `error.type`: Error class name on failure

Detects capnweb-style `{ success: false, error }` responses and marks spans as errors.

## Trace Context Propagation

For distributed tracing across services:

```typescript
import { injectTraceHeaders, extractTraceContext, getTraceId, getSpanId } from '@catalyst/telemetry'

// Outbound request — inject trace headers
const headers = {}
injectTraceHeaders(headers)
await fetch('http://other-service/api', { headers })

// Inbound request — extract parent context
const parentContext = extractTraceContext(request.headers)

// Get current trace/span IDs (e.g., for logging)
const traceId = getTraceId()
const spanId = getSpanId()
```

## PII Sanitization

Sensitive data is automatically redacted from telemetry:

```typescript
import { sanitizeAttributes } from '@catalyst/telemetry'

const attrs = sanitizeAttributes({
  'user.email': 'alice@example.com', // → '[EMAIL]'
  'auth.token': 'secret123', // → '[REDACTED]'
  'http.method': 'GET', // → 'GET' (unchanged)
})
```

Redacted keys: `password`, `token`, `secret`, `authorization`, `cookie`, `api_key`, `bearer`, `credential`, `private_key`

## Path Normalization

Prevents high-cardinality span names:

```typescript
import { normalizePath } from '@catalyst/telemetry'

normalizePath('/users/123') // → '/users/:id'
normalizePath('/orders/550e8400-e29b-41d4-..') // → '/orders/:uuid'
```

## Environment Variables

| Variable                      | Description                                        |
| ----------------------------- | -------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint URL                                  |
| `OTEL_SERVICE_NAME`           | Service name (can also be set via `initTelemetry`) |

## Bun Compatibility

This package is designed for Bun runtime:

- Uses OTLP HTTP — simpler than gRPC, works everywhere (gRPC also supported since Bun 1.2)
- No auto-instrumentation — Bun doesn't support Node.js `--require` hooks, so manual instrumentation via middleware is required
- AsyncLocalStorage works since Bun 1.0 — required for trace context propagation
