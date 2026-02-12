# ADR-0003: Observability Backend Selection

**Status:** Proposed
**Date:** 2026-01-26
**Decision Owner(s):** @jtaylor-orbis @jaeyojae @gsantiago-orbis
**Technical Story:** Select license-compliant backends for metrics, traces, and logs storage

## Context

[[0001-unified-opentelemetry-observability|ADR-0001]] established OpenTelemetry as the collection and instrumentation layer. This ADR addresses the separate concern of backend selection — where telemetry data is stored and visualized.

### Separation of Concerns

```
┌─────────────────────────────────────────────────────────────────┐
│                     COLLECTION LAYER                            │
│                     (ADR-0001 scope)                            │
│                                                                 │
│   Application → @catalyst/telemetry → OTEL Collector            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ OTLP export
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 OBSERVABILITY STORAGE LAYER                     │
│                     (This ADR's scope)                          │
│                                                                 │
│   Metrics Backend │ Traces Backend │ Logs Backend               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                  APPLICATION STORAGE LAYER                      │
│                     (ADR-0004 scope)                            │
│                                                                 │
│   Users │ Service Accounts │ Routes │ Peers │ Revocations       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Requirements

| Requirement                           | Priority | Notes                               |
| ------------------------------------- | -------- | ----------------------------------- |
| License compliance (Apache 2.0 / MIT) | Must     | Project is distributed software     |
| OTLP ingestion support                | Must     | Collector exports via OTLP          |
| Native query UI                       | Should   | Avoid external dashboard dependency |
| Self-hosted option                    | Must     | On-prem deployment requirement      |
| Horizontal scalability                | Could    | Future growth consideration         |

### Licensing Constraints

Since catalyst-router is distributed software, we cannot include or bundle AGPL-licensed components:

| License    | Can Use? | Reason                           |
| ---------- | -------- | -------------------------------- |
| Apache 2.0 | Yes      | Permissive, distribution-safe    |
| MIT        | Yes      | Permissive, distribution-safe    |
| BSD        | Yes      | Permissive, distribution-safe    |
| AGPL 3.0   | No       | Copyleft triggers on network use |
| SSPL       | No       | Source-available, not OSS        |

## Decision

### Chosen Backends

| Signal      | Backend          | License    | Rationale                                       |
| ----------- | ---------------- | ---------- | ----------------------------------------------- |
| **Metrics** | Prometheus       | Apache 2.0 | Industry standard, extensive ecosystem, PromQL  |
| **Traces**  | Jaeger           | Apache 2.0 | Best-in-class UI, CNCF graduated, native OTLP   |
| **Logs**    | InfluxDB 2.x OSS | MIT        | License-compliant, native UI, simple operations |

### Architecture

```
                         ┌─────────────────────────┐
                         │     OTEL Collector      │
                         │      :4317/:4318        │
                         └────────────┬────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
              ▼                       ▼                       ▼
    ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
    │   Prometheus    │     │     Jaeger      │     │  InfluxDB 2.x   │
    │     :9090       │     │    :16686       │     │     :8086       │
    │   (metrics)     │     │   (traces)      │     │    (logs)       │
    │   Apache 2.0    │     │   Apache 2.0    │     │      MIT        │
    └────────┬────────┘     └────────┬────────┘     └────────┬────────┘
             │                       │                       │
             │ Prometheus UI         │ Jaeger UI             │ InfluxDB UI
             │ :9090                 │ :16686                │ :8086
             └───────────────────────┴───────────────────────┘
```

### Rationale

1. **Prometheus for Metrics**
   - Industry standard with largest ecosystem
   - PromQL is well-documented and widely known
   - Built-in UI sufficient for development and debugging
   - Alertmanager integration for production alerting

2. **Jaeger for Traces**
   - Best trace visualization UI in the Apache-licensed space
   - Native OTLP support (no translation needed)
   - Service maps, trace comparison, latency histograms
   - CNCF graduated — strong community support

3. **InfluxDB 2.x for Logs**
   - Only MIT-licensed option with native UI
   - Flux queries can correlate logs with metrics
   - Simple single-binary deployment
   - Good enough for log exploration (not full-text search)

### Trade-offs Accepted

- **No unified dashboard** — Each backend has its own UI. We accept this to avoid AGPL Grafana.
- **InfluxDB for logs is non-traditional** — Purpose-built log systems (Loki, Elasticsearch) are better, but license constraints eliminate them.
- **Three UIs to learn** — Teams must become familiar with Prometheus UI, Jaeger UI, and InfluxDB UI.

## Consequences

### Positive

- **Full license compliance** — All backends are Apache 2.0 or MIT
- **Distribution-safe** — Can bundle observability stack with catalyst-router
- **Native UIs** — Each backend provides built-in visualization
- **Industry standards** — Prometheus and Jaeger are CNCF projects
- **Simple operations** — No complex dependencies (no Kafka, no Cassandra)

### Negative

- **No unified dashboard** — Cannot use Grafana for single-pane-of-glass view
- **Limited log search** — InfluxDB lacks full-text search (no grep-style queries)
- **Learning curve** — Three different query languages (PromQL, Jaeger query, Flux)
- **No cross-signal correlation UI** — Cannot click from trace to related logs in same view

### Neutral

- **Separate ports** — Each UI on different port (9090, 16686, 8086)
- **Storage isolation** — Each backend manages its own storage

## Alternatives for Future Consideration

If license constraints change or we use backends as external services (not bundled):

| Scenario                         | Recommendation                                                     |
| -------------------------------- | ------------------------------------------------------------------ |
| SaaS observability               | Datadog, Honeycomb, or Grafana Cloud (AGPL not triggered for SaaS) |
| Self-hosted with AGPL acceptance | Grafana + Loki + Tempo (best integrated experience)                |
| Enterprise deployment            | VictoriaMetrics + Jaeger + OpenSearch                              |

## Compliance

- All selected backends are Apache 2.0 or MIT licensed
- Safe to distribute with catalyst-router
- No AGPL or SSPL components included

## Related Decisions

- [[0001-unified-opentelemetry-observability|ADR-0001]] — Collection layer (OpenTelemetry SDK)
- [[0002-logging-library-selection|ADR-0002]] — Logging library (LogTape)
- [[0004-sqlite-storage-backend|ADR-0004]] — Application storage layer (SQLite)

## References

- [Prometheus License](https://github.com/prometheus/prometheus/blob/main/LICENSE) — Apache 2.0
- [Jaeger License](https://github.com/jaegertracing/jaeger/blob/main/LICENSE) — Apache 2.0
- [InfluxDB 2.x OSS License](https://github.com/influxdata/influxdb/blob/master/LICENSE) — MIT
- [OTEL Collector Exporters](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter)

---

## Appendix: Options Considered

<details>
<summary>Click to expand full options analysis</summary>

### Decision Drivers

- **License compliance** — Must be Apache 2.0, MIT, or BSD licensed
- **OTLP native** — Should accept OTLP directly or via collector exporter
- **Operational simplicity** — Prefer fewer moving parts
- **Community adoption** — Well-documented, actively maintained
- **Native UI** — Each backend should provide its own visualization

### Metrics Backend

#### Option M1: Prometheus

| Aspect         | Details                               |
| -------------- | ------------------------------------- |
| License        | Apache 2.0                            |
| OTLP Support   | Via `prometheusremotewrite` exporter  |
| Query Language | PromQL                                |
| Native UI      | Yes (built-in)                        |
| Scalability    | Single-node; use Thanos/Cortex for HA |

**Pros:**

- Industry standard for cloud-native metrics
- Extensive ecosystem (exporters, integrations)
- Built-in alerting via Alertmanager
- Native UI for ad-hoc queries

**Cons:**

- Single-node by default (requires Thanos for HA)
- Pull-based model requires adaptation for OTLP push

#### Option M2: InfluxDB (for metrics)

| Aspect         | Details                           |
| -------------- | --------------------------------- |
| License        | MIT (2.x OSS)                     |
| OTLP Support   | Via collector `influxdb` exporter |
| Query Language | Flux                              |
| Native UI      | Yes (built-in)                    |

**Pros:**

- Single binary, easy operations
- Good time-series compression
- Native UI with dashboarding

**Cons:**

- Less ecosystem adoption than Prometheus
- Flux learning curve

#### Option M3: VictoriaMetrics

| Aspect         | Details                       |
| -------------- | ----------------------------- |
| License        | Apache 2.0                    |
| OTLP Support   | Native OTLP ingestion         |
| Query Language | MetricsQL (PromQL-compatible) |
| Native UI      | vmui (basic)                  |

**Pros:**

- Better compression than Prometheus
- Native OTLP support
- PromQL compatible

**Cons:**

- Smaller community than Prometheus
- Enterprise features require license

### Traces Backend

#### Option T1: Jaeger

| Aspect       | Details                          |
| ------------ | -------------------------------- |
| License      | Apache 2.0                       |
| OTLP Support | Native (collector mode)          |
| Storage      | Badger, Cassandra, Elasticsearch |
| Native UI    | Yes (full-featured)              |

**Pros:**

- CNCF graduated project
- Excellent trace visualization
- Service dependency graphs
- Comparison features

**Cons:**

- Requires separate storage for production (Cassandra/ES)

#### Option T2: Tempo (Grafana)

| Aspect  | Details  |
| ------- | -------- |
| License | AGPL 3.0 |

**Excluded due to AGPL license.**

#### Option T3: Zipkin

| Aspect       | Details                         |
| ------------ | ------------------------------- |
| License      | Apache 2.0                      |
| OTLP Support | Via collector `zipkin` exporter |
| Storage      | In-memory, MySQL, Cassandra, ES |
| Native UI    | Yes                             |

**Pros:**

- Mature project
- Simple deployment

**Cons:**

- Less feature-rich UI than Jaeger
- OTLP requires translation

### Logs Backend

#### Option L1: InfluxDB 2.x OSS

| Aspect         | Details                           |
| -------------- | --------------------------------- |
| License        | MIT                               |
| OTLP Support   | Via collector `influxdb` exporter |
| Query Language | Flux                              |
| Native UI      | Yes (Data Explorer)               |

**Pros:**

- MIT licensed (distribution-safe)
- Can store both logs and metrics
- Built-in dashboarding
- Good retention policies

**Cons:**

- Not purpose-built for logs
- Flux learning curve

#### Option L2: Loki (Grafana)

| Aspect  | Details  |
| ------- | -------- |
| License | AGPL 3.0 |

**Excluded due to AGPL license.**

#### Option L3: Elasticsearch (OpenSearch)

| Aspect         | Details                                |
| -------------- | -------------------------------------- |
| License        | Apache 2.0 (OpenSearch)                |
| OTLP Support   | Via collector `elasticsearch` exporter |
| Query Language | Query DSL                              |
| Native UI      | OpenSearch Dashboards                  |

**Pros:**

- Purpose-built for log search
- Full-text indexing
- OpenSearch Dashboards for visualization

**Cons:**

- Heavy resource requirements
- Complex operations (JVM tuning)
- Overkill for smaller deployments

#### Option L4: ClickHouse

| Aspect         | Details                             |
| -------------- | ----------------------------------- |
| License        | Apache 2.0                          |
| OTLP Support   | Via collector `clickhouse` exporter |
| Query Language | SQL                                 |
| Native UI      | Basic (play.clickhouse.com style)   |

**Pros:**

- Excellent compression
- Fast analytical queries
- SQL interface

**Cons:**

- No built-in log exploration UI
- Requires separate visualization layer

</details>
