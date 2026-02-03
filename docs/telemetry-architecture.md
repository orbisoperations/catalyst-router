# Telemetry Architecture

## Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              YOUR SERVICE                                        │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │                         @catalyst/sdk                                      │ │
│  │                                                                            │ │
│  │   CatalystService                                                          │ │
│  │   ├── app: Hono ──────────────────┐                                        │ │
│  │   ├── tracer ─────────────────────┼──┐                                     │ │
│  │   ├── meter ──────────────────────┼──┼──┐                                  │ │
│  │   ├── onShutdown() ───────────────┼──┼──┼──┐                               │ │
│  │   └── serve() → { fetch, port }   │  │  │  │                               │ │
│  │                                   │  │  │  │                               │ │
│  └───────────────────────────────────┼──┼──┼──┼───────────────────────────────┘ │
│                                      │  │  │  │                                  │
│  ┌───────────────────────────────────┼──┼──┼──┼───────────────────────────────┐ │
│  │                      @catalyst/telemetry                                   │ │
│  │                                   │  │  │  │                               │ │
│  │   initTelemetry()                 │  │  │  │                               │ │
│  │   ┌───────────────────────────────┴──┴──┴──┴─────────────────────────────┐ │ │
│  │   │                                                                      │ │ │
│  │   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │ │ │
│  │   │  │   Tracer     │  │    Meter     │  │   Logger     │               │ │ │
│  │   │  │              │  │              │  │  (LogTape)   │               │ │ │
│  │   │  │ getTracer()  │  │  getMeter()  │  │  getLogger() │               │ │ │
│  │   │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │ │ │
│  │   │         │                 │                 │                        │ │ │
│  │   │  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐               │ │ │
│  │   │  │    Spans     │  │   Metrics    │  │  Log Records │               │ │ │
│  │   │  │              │  │              │  │              │               │ │ │
│  │   │  │ - trace_id   │  │ - counters   │  │ - trace_id   │               │ │ │
│  │   │  │ - span_id    │  │ - histograms │  │ - span_id    │               │ │ │
│  │   │  │ - attributes │  │ - gauges     │  │ - severity   │               │ │ │
│  │   │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │ │ │
│  │   │         │                 │                 │                        │ │ │
│  │   └─────────┼─────────────────┼─────────────────┼────────────────────────┘ │ │
│  │             │                 │                 │                          │ │
│  │   ┌─────────┴─────────────────┴─────────────────┴────────────────────────┐ │ │
│  │   │                     OTLP HTTP Exporters                              │ │ │
│  │   │                                                                      │ │ │
│  │   │  BatchSpanProcessor    PeriodicMetricReader    OTEL Log Sink        │ │ │
│  │   │  (queue: 2048)         (interval: 60s)         (via @logtape/otel)  │ │ │
│  │   └──────────────────────────────┬───────────────────────────────────────┘ │ │
│  │                                  │                                         │ │
│  │   Middleware:                    │                                         │ │
│  │   ┌────────────────────┐  ┌──────┴───────────┐  ┌──────────────────┐     │ │
│  │   │ telemetryMiddleware│  │ yogaTelemetry    │  │ instrumentRpc    │     │ │
│  │   │ (Hono HTTP)        │  │ Plugin (GraphQL) │  │ Target (capnweb) │     │ │
│  │   │ + metrics histogram│  │                  │  │                  │     │ │
│  │   └────────────────────┘  └──────────────────┘  └──────────────────┘     │ │
│  │                                                                            │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ OTLP/HTTP :4318
                                       │ (traces, metrics, logs)
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           OTEL COLLECTOR :4317/:4318                             │
│                                                                                  │
│   ┌─────────────┐    ┌─────────────────────────────┐    ┌─────────────────────┐ │
│   │  Receivers  │    │        Processors           │    │     Exporters       │ │
│   │             │    │                             │    │                     │ │
│   │  OTLP       │───▶│  memory_limiter             │───▶│  otlp/jaeger       │──┼──▶ Jaeger
│   │  - gRPC     │    │  batch                      │    │  prometheusremote  │──┼──▶ Prometheus
│   │  - HTTP     │    │  attributes                 │    │  influxdb          │──┼──▶ InfluxDB
│   │             │    │                             │    │  debug (dev)       │ │
│   └─────────────┘    └─────────────────────────────┘    └─────────────────────┘ │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
                                       │
           ┌───────────────────────────┼───────────────────────────┐
           │                           │                           │
           ▼                           ▼                           ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│       JAEGER        │   │     PROMETHEUS      │   │      INFLUXDB       │
│       :16687        │   │       :9091         │   │       :8087         │
│                     │   │                     │   │                     │
│  ┌───────────────┐  │   │  ┌───────────────┐  │   │  ┌───────────────┐  │
│  │    Traces     │  │   │  │    Metrics    │  │   │  │     Logs      │  │
│  │               │  │   │  │               │  │   │  │               │  │
│  │ - Trace ID    │  │   │  │ - Counters    │  │   │  │ - trace_id    │  │
│  │ - Span tree   │  │   │  │ - Histograms  │  │   │  │ - message     │  │
│  │ - Duration    │  │   │  │ - Gauges      │  │   │  │ - severity    │  │
│  │ - Attributes  │  │   │  │ - Labels      │  │   │  │ - attributes  │  │
│  │ - Events      │  │   │  │               │  │   │  │               │  │
│  └───────────────┘  │   └───────────────┘  │   │  └───────────────┘  │
│                     │   │                     │   │                     │
│  Jaeger UI          │   │  Prometheus UI      │   │  InfluxDB UI        │
│  - Search traces    │   │  - PromQL queries   │   │  - Flux queries     │
│  - Service maps     │   │  - Graphs           │   │  - Dashboards       │
│  - Latency analysis │   │  - Alerts           │   │  - Log exploration  │
└─────────────────────┘   └─────────────────────┘   └─────────────────────┘
```

## Data Flow

### 1. Application Layer

```
┌─────────────────────────────────────────────────────────────────┐
│                        Service Code                             │
│                                                                 │
│   // Initialize telemetry FIRST                                 │
│   await initTelemetry({ serviceName: 'my-service' })            │
│                                                                 │
│   // Create service                                             │
│   const service = new CatalystService({ name: 'my-service' })   │
│                                                                 │
│   // Add middleware (auto-instruments HTTP)                     │
│   service.app.use('*', telemetryMiddleware())                   │
│                                                                 │
│   // Manual instrumentation                                     │
│   logger.info('Processing request', { userId })                 │
│   const span = tracer.startSpan('db-query')                     │
│   counter.add(1, { endpoint: '/api' })                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
```

### 2. Telemetry SDK Layer

```
┌─────────────────────────────────────────────────────────────────┐
│                    @catalyst/telemetry                          │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                    Processing                           │   │
│   │                                                         │   │
│   │  Traces:                                                │   │
│   │  ├── Add service.name, service.version attributes       │   │
│   │  ├── W3C Trace Context propagation                      │   │
│   │  └── BatchSpanProcessor (queue before export)           │   │
│   │                                                         │   │
│   │  Metrics:                                               │   │
│   │  ├── Add resource attributes                            │   │
│   │  └── PeriodicExportingMetricReader (60s interval)       │   │
│   │                                                         │   │
│   │  Logs:                                                  │   │
│   │  ├── Inject trace_id/span_id from active context        │   │
│   │  ├── sanitizeAttributes() — redact PII                  │   │
│   │  └── Console sink + OTEL sink                           │   │
│   │                                                         │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ OTLP/HTTP
                              ▼
```

### 3. Collector Layer

```
┌─────────────────────────────────────────────────────────────────┐
│                      OTEL Collector                             │
│                                                                 │
│   Receive ──▶ Process ──▶ Export                                │
│                                                                 │
│   ┌─────────┐   ┌──────────────────┐   ┌─────────────────────┐  │
│   │  OTLP   │   │  memory_limiter  │   │  Traces → Jaeger    │  │
│   │ receiver│──▶│  batch           │──▶│  Metrics → Prom     │  │
│   │         │   │  attributes      │   │  Logs → InfluxDB    │  │
│   └─────────┘   └──────────────────┘   └─────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Trace Context Propagation

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│   Gateway    │         │   Auth API   │         │  Database    │
│              │         │              │         │              │
│  trace_id: A │────────▶│  trace_id: A │────────▶│  trace_id: A │
│  span_id: 1  │         │  span_id: 2  │         │  span_id: 3  │
│              │ HTTP    │  parent: 1   │ HTTP    │  parent: 2   │
│              │         │              │         │              │
└──────────────┘         └──────────────┘         └──────────────┘
       │                        │                        │
       │ traceparent header:    │                        │
       │ 00-{trace_id}-{span_id}-01                      │
       │                        │                        │
       ▼                        ▼                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Jaeger UI                               │
│                                                                 │
│   Trace A                                                       │
│   ├── Gateway (span 1) ─────────────────────────── 150ms        │
│   │   └── Auth API (span 2) ──────────────── 80ms               │
│   │       └── Database (span 3) ──────── 45ms                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Log-Trace Correlation

```
┌─────────────────────────────────────────────────────────────────┐
│                         Service Code                            │
│                                                                 │
│   const span = tracer.startSpan('process-order')                │
│   // span creates trace context                                 │
│                                                                 │
│   logger.info('Processing order', { orderId: 123 })             │
│   // logger auto-injects trace_id and span_id                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Log Record (OTEL)                          │
│                                                                 │
│   {                                                             │
│     "body": "Processing order",                                 │
│     "severity": "INFO",                                         │
│     "trace_id": "abc123...",    ◀── Same as span                │
│     "span_id": "def456...",     ◀── Same as span                │
│     "attributes": {                                             │
│       "orderId": 123                                            │
│     }                                                           │
│   }                                                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┴────────────────────┐
         ▼                                         ▼
┌─────────────────────┐               ┌─────────────────────┐
│      Jaeger         │               │     InfluxDB        │
│                     │               │                     │
│  Click trace_id ────┼───────────────┼──▶ Filter by        │
│  to see logs        │               │    trace_id         │
│                     │               │                     │
└─────────────────────┘               └─────────────────────┘
```

## Middleware Auto-Instrumentation

### HTTP (Hono)

```
┌─────────────────────────────────────────────────────────────────┐
│                    telemetryMiddleware()                        │
│                                                                 │
│   Request ──▶ Extract traceparent ──▶ Start span ──▶ Handler    │
│                                                         │       │
│                                                         ▼       │
│   Response ◀── Set status code ◀── End span ◀── Handler done    │
│                                                                 │
│   Span attributes:                                              │
│   ├── http.request.method: "GET"                                │
│   ├── http.route: "/users/:id"      (normalized)                │
│   ├── url.path: "/users/123"        (original)                  │
│   └── http.response.status_code: 200                            │
│                                                                 │
│   Metrics (http.server.request.duration histogram):             │
│   ├── http.request.method: "GET"                                │
│   ├── http.route: "/users/:id"                                  │
│   ├── http.response.status_code: 200                            │
│   ├── url.scheme: "https"                                       │
│   └── error.type: "500"             (on errors only)            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### GraphQL (Yoga)

```
┌─────────────────────────────────────────────────────────────────┐
│                  createYogaTelemetryPlugin()                    │
│                                                                 │
│   GraphQL Request                                               │
│   │                                                             │
│   ├── parse ────────────────────────────────────▶ span          │
│   ├── validate ─────────────────────────────────▶ span          │
│   ├── execute                                                   │
│   │   ├── Query.users ──────────────────────────▶ span          │
│   │   ├── User.posts ───────────────────────────▶ span          │
│   │   └── Post.author ──────────────────────────▶ span          │
│   │                                                             │
│   Response                                                      │
│                                                                 │
│   Span attributes:                                              │
│   ├── graphql.operation.name: "GetUsers"                        │
│   ├── graphql.operation.type: "query"                           │
│   └── graphql.document: "query GetUsers { ... }"                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### RPC (capnweb)

```
┌─────────────────────────────────────────────────────────────────┐
│                   instrumentRpcTarget()                         │
│                                                                 │
│   RPC Method Call                                               │
│   │                                                             │
│   ├── Proxy intercepts method call                              │
│   ├── Start span: "RPC {serviceName}.{method}"                  │
│   ├── Execute original method                                   │
│   ├── Check for { success: false, error } response              │
│   └── End span with status                                      │
│                                                                 │
│   Span attributes:                                              │
│   ├── rpc.system.name: "capnweb"                                │
│   ├── rpc.method: "login"                                       │
│   └── error.type: "AuthError"        (on error)                 │
│                                                                 │
│   Optional (if recordArguments/recordResult enabled):           │
│   ├── catalyst.rpc.arguments: {...}  (PII-sanitized)            │
│   └── catalyst.rpc.result: {...}                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## PII Sanitization

```
┌─────────────────────────────────────────────────────────────────┐
│                     sanitizeAttributes()                        │
│                                                                 │
│   Input:                          Output:                       │
│   {                               {                             │
│     "user.email": "a@b.com",  ──▶   "user.email": "[EMAIL]",    │
│     "auth.token": "secret",   ──▶   "auth.token": "[REDACTED]", │
│     "http.method": "GET",     ──▶   "http.method": "GET",       │
│     "nested": {                     "nested": {                 │
│       "password": "123"       ──▶     "password": "[REDACTED]"  │
│     }                               }                           │
│   }                               }                             │
│                                                                 │
│   Redacted keys:                                                │
│   password, token, secret, authorization, cookie,               │
│   api_key, bearer, credential, private_key                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Path Normalization

```
┌─────────────────────────────────────────────────────────────────┐
│                       normalizePath()                           │
│                                                                 │
│   /users/123                    ──▶  /users/:id                 │
│   /orders/550e8400-e29b-41d4   ──▶  /orders/:uuid               │
│   /api/v2/items/456            ──▶  /api/v2/items/:id           │
│                                                                 │
│   WHY: Prevents high-cardinality metric/span names              │
│   that would explode storage costs                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```
