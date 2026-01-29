# ADR-0001: Unified OpenTelemetry Observability

**Status:** Accepted
**Date:** 2026-01-26
**Decision Owner(s):** @jtaylor-orbis @jaeyojae @gsantiago-orbis
**Technical Story:** Enable end-to-end request tracing across federated GraphQL services

## Context

Catalyst-node is a distributed control plane with multiple services:

- **Orchestrator** - BGP-style peering, route table management
- **Gateway** - GraphQL federation via schema stitching
- **Auth** - JWT signing, JWKS endpoint, key management
- **Federated Subgraphs** - User services (orders-api, products-api, books-api, etc.)

### Current State (V1)

The existing observability is fragmented:

- Basic `console.log` / JSON logging with no structured correlation
- No distributed tracing across service boundaries
- No metrics collection infrastructure
- No ability to trace a request from gateway through subgraphs
- Debugging production issues requires manual log correlation

### Problems to Solve

1. **No request tracing** - Cannot trace a GraphQL query from gateway through federated subgraphs
2. **No correlation** - Logs, metrics, and traces are disconnected; no shared `trace_id`
3. **No performance visibility** - Unknown latency characteristics of subgraph calls
4. **Debugging is manual** - Investigating issues requires piecing together logs from multiple services
5. **No SLI/SLO foundation** - Cannot measure or alert on service-level objectives

### Requirements

- Distributed tracing across HTTP and RPC boundaries
- Unified logging with automatic trace correlation
- Metrics for peer lifecycle, route changes, GraphQL federation
- Backend-agnostic design (ability to switch from Jaeger/Prometheus to Datadog)
- Developer-friendly logging API (not raw OTEL SDK)
- Support for both Kubernetes and Docker Compose deployments

### Licensing Constraints

Since catalyst-node is distributed software, we cannot use AGPL-licensed components. This affects backend selection:

| Component        | License    | Status     |
| ---------------- | ---------- | ---------- |
| OTEL Collector   | Apache 2.0 | Approved   |
| Prometheus       | Apache 2.0 | Approved   |
| Jaeger           | Apache 2.0 | Approved   |
| InfluxDB 2.x OSS | MIT        | Approved   |
| Grafana          | AGPL 3.0   | Cannot use |
| Loki             | AGPL 3.0   | Cannot use |

## Decision

**Chosen Option: OpenTelemetry (Unified SDK)**

We will adopt OpenTelemetry as the unified observability framework with the following architecture:

```
Services → @catalyst/telemetry → OTLP → OTEL Collector → Backends
```

### Rationale

1. **Single SDK for all signals** — One package (`@catalyst/telemetry`) provides traces, metrics, and logs with automatic correlation via shared `trace_id`
2. **Backend-agnostic** — OTEL Collector is the only egress point; swap Jaeger→Tempo by editing collector config, no code changes
3. **Industry standard** — OTEL is the CNCF standard with broad ecosystem support, ensuring long-term viability
4. **GraphQL support** — First-class instrumentation via GraphQL Yoga's `useOpenTelemetry` plugin
5. **W3C Trace Context** — Standard propagation ensures interoperability with external services

### Key Components

1. **SDK Package** (`packages/telemetry`)
   - OTEL SDK initialization (traces, metrics, logs)
   - Tracer and Meter utilities
   - LogTape configuration with OTEL sink
   - W3C Trace Context propagation helpers
   - Hono HTTP middleware
   - Capnweb RPC instrumentation

2. **Integration Layers**
   - Layer 1: SDK package (all services)
   - Layer 2: ObservabilityPlugin (orchestrator state changes)
   - Layer 3: Middleware (HTTP/RPC boundaries)

3. **Trace Propagation**
   - Gateway injects `traceparent` header when calling subgraphs
   - Subgraphs extract context via GraphQL Yoga OTEL plugin
   - All spans share the same trace_id

4. **Logging Strategy**
   - LogTape as developer API (`logger.info\`message\``)
   - Console sink in development (pretty-printed)
   - OTEL sink in all environments (exports to collector)
   - Automatic trace_id injection from active span

5. **Backend Agnostic**
   - OTEL Collector is the only egress point
   - Backends configured via collector exporters
   - Switch backends without application changes

### Trade-offs Accepted

- **OTEL Logs SDK still maturing** — We accept this because LogTape provides the developer API; OTEL Logs is just the transport
- **~15 packages added per service** — Acceptable given the unified SDK benefits vs. managing separate vendor SDKs
- **Requires OTEL Collector infrastructure** — This is a reasonable operational cost for the flexibility gained

## Consequences

### Positive

- **End-to-end tracing** - Single trace shows request flow through gateway and all subgraphs
- **Automatic correlation** - Logs include trace_id without manual injection
- **Backend flexibility** - Can migrate from Jaeger/Prometheus to Datadog by changing collector config
- **Industry standard** - OTEL is the CNCF standard, broad ecosystem support
- **Reduced complexity** - Single telemetry package vs. multiple vendor SDKs
- **GraphQL support** - First-class instrumentation via Yoga plugin
- **Developer experience** - LogTape provides clean API, console output in dev

### Negative

- **Additional dependency** - OTEL SDK adds ~15 packages to each service
- **Collector infrastructure** - Requires running OTEL Collector (sidecar or shared)
- **Learning curve** - Team needs to understand OTEL concepts (spans, metrics, propagation)
- **Initialization order matters** - Telemetry must be imported before other modules
- **LogTape is newer** - Less battle-tested than Pino/Winston

### Neutral

- **Performance overhead** - Typical OTEL overhead is <1ms per request (acceptable)
- **Storage requirements** - Depends on sampling rate and retention policy
- **Bun compatibility** - OTEL Node SDK works on Bun but not officially supported

## Risks and Mitigations

| Risk                       | Likelihood | Impact | Mitigation                                               |
| -------------------------- | ---------- | ------ | -------------------------------------------------------- |
| OTEL Collector unavailable | Medium     | High   | Configure SDK with drop-on-failure, add queue buffering  |
| High cardinality metrics   | Medium     | Medium | Define cardinality limits, use allowlists for labels     |
| PII in traces/logs         | Medium     | High   | Implement attribute scrubbing, document sensitive fields |
| Performance regression     | Low        | Medium | Benchmark before/after, implement sampling               |

## Compliance

- Trace data retention must comply with data governance policies
- PII must be scrubbed from telemetry before export
- Access to observability backends requires appropriate authorization

## Related Decisions

- [ADR-0002](./0002-logging-library-selection.md) - Logging Library Selection (LogTape vs Pino)
- [ADR-0003](./0003-observability-backends.md) - Observability Backend Selection (observability storage)
- [ADR-0004](./0004-sqlite-storage-backend.md) - Application Storage Backend (SQLite)

## References

- [OpenTelemetry Documentation](https://opentelemetry.io/docs/)
- [W3C Trace Context Specification](https://www.w3.org/TR/trace-context/)
- [GraphQL Yoga OTEL Plugin](https://the-guild.dev/graphql/yoga-server/docs/features/tracing)
- [LogTape Documentation](https://logtape.org/)

---

## Appendix: Options Considered

<details>
<summary>Click to expand full options analysis</summary>

### Decision Drivers

- **Interoperability** - Must work across Bun runtime, Hono framework, GraphQL Yoga
- **Industry Standard** - Prefer widely-adopted standards over proprietary solutions
- **Minimal Coupling** - Application code should not depend on specific backends
- **Developer Experience** - Logging API should be ergonomic, not verbose
- **Production Ready** - Must handle failure gracefully, support sampling at scale
- **License Compliance** - All components must be Apache 2.0 or MIT licensed (project is distributed)

### Option 1: OpenTelemetry (Unified SDK)

Use OpenTelemetry SDK for traces and metrics, with LogTape as the logging API bridged to OTEL Logs via a custom sink.

**Approach:**

- Single `@catalyst/telemetry` package for all services
- OTEL Collector as single egress point for all signals
- W3C Trace Context for cross-service propagation
- LogTape provides developer-friendly API, sinks to OTEL and console
- GraphQL Yoga's `useOpenTelemetry` plugin for automatic instrumentation

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            APPLICATION                                      │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    @catalyst/telemetry                              │   │
│   │                                                                     │   │
│   │   ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐   │   │
│   │   │  OTEL Metrics   │   │  OTEL Traces    │   │  LogTape        │   │   │
│   │   │                 │   │                 │   │  → OTEL Sink    │   │   │
│   │   │ Counter, Gauge  │   │ Spans, Context  │   │                 │   │   │
│   │   │ Histogram       │   │ W3C Propagation │   │ Auto trace_id   │   │   │
│   │   └────────┬────────┘   └────────┬────────┘   └────────┬────────┘   │   │
│   │            │                     │                     │            │   │
│   │            └─────────────────────┼─────────────────────┘            │   │
│   │                                  │                                  │   │
│   └──────────────────────────────────┼──────────────────────────────────┘   │
│                                      │                                      │
└──────────────────────────────────────┼──────────────────────────────────────┘
                                       │
                                       │ OTLP (HTTP/gRPC)
                                       │ All 3 signals unified
                                       ▼
                         ┌─────────────────────────┐
                         │     OTEL Collector      │
                         │      :4317/:4318        │
                         │                         │
                         │  Single egress point    │
                         │  for all telemetry      │
                         │                         │
                         │  Processors:            │
                         │  - memory_limiter       │
                         │  - batch                │
                         │  - tail_sampling        │
                         └────────────┬────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
              ▼                       ▼                       ▼
    ┌─────────────────────────────────────────────────────────────────┐
    │                   OBSERVABILITY STORAGE LAYER                   │
    │                       (ADR-0003 scope)                          │
    │                                                                 │
    └─────────────────────────────────────────────────────────────────┘
```

**Pros:**

- Single SDK package for all signals
- Backend-agnostic (swap Jaeger→Tempo by editing collector config)
- Automatic trace_id correlation across all signals
- OTEL is CNCF standard with broad ecosystem

**Cons:**

- OTEL Logs SDK still maturing
- ~15 packages added to each service
- Requires OTEL Collector infrastructure

### Option 2: Vendor-Specific SDK (Datadog)

Use Datadog's APM SDK directly in all services.

**Approach:**

- `dd-trace` library for auto-instrumentation
- Datadog Agent as sidecar
- Proprietary trace context propagation

**Pros:**

- Excellent out-of-box experience
- Unified dashboard included
- Strong support

**Cons:**

- Vendor lock-in
- Requires Datadog subscription
- Proprietary protocol

### Option 3: Hybrid Stack (prom-client + OTEL Traces + Promtail)

Use best-of-breed tools for each signal with shared trace_id correlation, but without full OTEL unification.

**Approach:**

- `prom-client` for metrics (Prometheus scrapes `/metrics` endpoint)
- `@opentelemetry/sdk` for traces only (OTLP push to Collector → Jaeger)
- `@logtape` for logs (stdout → Telegraf → InfluxDB)
- Each backend provides its own UI (Prometheus UI, Jaeger UI, InfluxDB UI)

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            APPLICATION                                       │
│                                                                              │
│   ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐           │
│   │   prom-client   │   │   @otel/sdk     │   │   @logtape      │           │
│   │   (METRICS)     │   │   (TRACES)      │   │   (LOGS)        │           │
│   │   Apache 2.0    │   │   Apache 2.0    │   │      MIT        │           │
│   │ Counter, Gauge  │   │ Spans, Context  │   │ JSON structured │           │
│   │ Histogram       │   │                 │   │ with trace_id   │           │
│   └────────┬────────┘   └────────┬────────┘   └────────┬────────┘           │
│            │                     │                     │                    │
└────────────┼─────────────────────┼─────────────────────┼────────────────────┘
             │                     │                     │
             │ HTTP pull           │ OTLP push           │ stdout/file
             │ /metrics            │ :4318               │
             ▼                     ▼                     ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────────────────────┐
│   Prometheus    │   │  OTEL Collector │   │           Telegraf              │
│     :9090       │   │     :4317       │   │            :8125                │
│   Apache 2.0    │   │   Apache 2.0    │   │           MIT                   │
│  Time-series DB │   │                 │   │  Log shipping agent             │
│  for metrics    │   │  Routes traces  │   │  - Reads container logs         │
│                 │   │  to Jaeger      │   │  - Parses JSON                  │
│                 │   │                 │   │  - Extracts trace_id            │
└────────┬────────┘   └────────┬────────┘   └─────────────┬───────────────────┘
```

**Pros:**

- Battle-tested tools for each signal
- Prometheus is the industry standard for metrics
- All components Apache 2.0 or MIT licensed (distribution safe)
- No OTEL Logs SDK complexity (still maturing)
- Each tool provides its own UI

**Cons:**

- Three different libraries instead of one
- Must manually inject trace_id into logs
- Cannot switch backends without code changes (metrics tied to prom-client)
- No unified dashboard (separate UIs for each signal)

### Option 4: No Observability

Continue with console.log and manual debugging.

**Pros:**

- No additional dependencies
- No operational overhead

**Cons:**

- Cannot trace distributed requests
- No metrics for performance analysis
- Debugging production issues is extremely difficult
- No foundation for SLIs/SLOs

</details>
