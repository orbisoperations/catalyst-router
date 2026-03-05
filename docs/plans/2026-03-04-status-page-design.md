# Status Page Design

**Date:** 2026-03-04
**Status:** Approved
**Epic:** Instrumentation & Logs (enables this work)
**Scope:** First page of the Catalyst admin UI — a status/observability dashboard

## Overview

A standalone web application (`apps/status-page`) that provides a unified observability dashboard for Catalyst Router nodes. This is the first page of what will become the full Catalyst admin UI. No authentication required initially.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Catalyst Node                         │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │Orchestrat│  │ Gateway  │  │   Auth   │  │ Envoy  │  │
│  │   or     │  │          │  │          │  │Service │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘  │
│       │              │              │             │      │
│       └──────────────┴──────┬───────┴─────────────┘      │
│                             │ OTLP                       │
│                      ┌──────▼──────┐                     │
│                      │    OTEL     │                     │
│                      │  Collector  │                     │
│                      └──────┬──────┘                     │
│              ┌──────────────┼──────────────┐             │
│              │              │              │             │
│        ┌─────▼─────┐ ┌─────▼─────┐ ┌──────▼─────┐      │
│        │Prometheus │ │  Jaeger   │ │ InfluxDB   │      │
│        │  :9090    │ │  :16686   │ │  :8086     │      │
│        │ (metrics) │ │ (traces)  │ │  (logs)    │      │
│        └─────┬─────┘ └─────┬─────┘ └──────┬─────┘      │
│              │              │              │             │
│        ┌─────▼──────────────▼──────────────▼─────┐      │
│        │         Status Page (apps/status-page)   │      │
│        │  Hono backend :4040 + React SPA (Vite)  │      │
│        └─────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
```

## Decisions

| Decision               | Choice                         | Rationale                                                  |
| ---------------------- | ------------------------------ | ---------------------------------------------------------- |
| Observability backends | Prometheus + Jaeger + InfluxDB | Per ADR-0003; license-compliant (Apache 2.0 / MIT)         |
| UI location            | Standalone `apps/status-page`  | Follows monorepo pattern; clean separation from gateway    |
| Frontend               | React SPA + Vite               | Will grow into full admin UI; rich component ecosystem     |
| Backend                | Hono                           | Matches existing apps (orchestrator, gateway, auth, envoy) |
| Data access            | Direct HTTP API queries        | Simple; each backend has well-documented REST APIs         |
| Detail level           | Full observability             | Logs + metrics charts + trace explorer per container       |
| Auth                   | None initially                 | Local admin tool; auth added later                         |
| Port                   | :4040                          |                                                            |

## App Structure

### Backend (Hono)

API routes that proxy queries to each observability backend:

- `GET /api/metrics/*` — proxies PromQL queries to Prometheus (:9090)
- `GET /api/traces/*` — proxies Jaeger query API (:16686)
- `GET /api/logs/*` — proxies InfluxDB Flux queries (:8086)
- `GET /api/health` — aggregated health status of all catalyst services (hits each service's `/health` endpoint)
- `GET /*` — serves the React SPA static files

Environment variables for backend URLs:

- `PROMETHEUS_URL` (default: `http://prometheus:9090`)
- `JAEGER_URL` (default: `http://jaeger:16686`)
- `INFLUXDB_URL` (default: `http://influxdb:8086`)

### Frontend (React + Vite)

Two tabs:

**Tab 1: Nodes** (initial scope)
Per-container view of each catalyst service (orchestrator, gateway, auth, envoy):

- Health status indicators (up/down/degraded)
- Log stream — real-time tail from InfluxDB, structured log display
- Metrics charts — request rate, error rate, latency time-series graphs via Prometheus
- Trace explorer — recent traces with span drill-down via Jaeger

**Tab 2: Adapters** (placeholder, built later)
Per-adapter metrics/logs for services running through catalyst nodes.

## Prerequisites

Before the status page can show real data, the **Instrumentation & Logs** epic tasks must land:

1. **OTEL collector config** — update `otel-collector-config.yaml` to export to Prometheus, Jaeger, and InfluxDB (currently exports to `debug` stdout only)
2. **Backend services** — add Prometheus, Jaeger, and InfluxDB as services in docker-compose
3. **Canonical structured logging** — the "Node Logs" task from the epic

The status page app can be built in parallel with stubbed/mock data, then connected once backends are live.

## OTEL Collector Config Changes

The collector config needs exporters added for each backend:

```yaml
exporters:
  debug:
    verbosity: detailed
  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true
  influxdb:
    endpoint: http://influxdb:8086
    org: catalyst
    bucket: logs
    token: ${INFLUXDB_TOKEN}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug, otlp/jaeger]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug, prometheusremotewrite]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug, influxdb]
```

## Docker Compose Additions

New services to add alongside existing topology:

```yaml
prometheus:
  image: prom/prometheus:v3.2.1
  ports:
    - '9090:9090'
  volumes:
    - prometheus-data:/prometheus

jaeger:
  image: jaegertracing/jaeger:2.5.0
  ports:
    - '16686:16686' # UI
    - '4317' # OTLP gRPC (internal only)
  environment:
    - COLLECTOR_OTLP_ENABLED=true

influxdb:
  image: influxdb:2.7-alpine
  ports:
    - '8086:8086'
  environment:
    - DOCKER_INFLUXDB_INIT_MODE=setup
    - DOCKER_INFLUXDB_INIT_USERNAME=admin
    - DOCKER_INFLUXDB_INIT_PASSWORD=catalyst-dev
    - DOCKER_INFLUXDB_INIT_ORG=catalyst
    - DOCKER_INFLUXDB_INIT_BUCKET=logs
  volumes:
    - influxdb-data:/var/lib/influxdb2

status-page:
  build:
    context: ..
    dockerfile: apps/status-page/Dockerfile
  ports:
    - '4040:4040'
  environment:
    - PORT=4040
    - PROMETHEUS_URL=http://prometheus:9090
    - JAEGER_URL=http://jaeger:16686
    - INFLUXDB_URL=http://influxdb:8086
```

## Related Documents

- [ADR-0001: Unified OpenTelemetry Observability](../adr/0001-unified-opentelemetry-observability.md)
- [ADR-0002: Logging Library Selection (LogTape)](../adr/0002-logging-library-selection.md)
- [ADR-0003: Observability Backend Selection](../adr/0003-observability-backends.md)
- [Notion Epic: Instrumentation & Logs](https://www.notion.so/31847ad1da7980d494d2d65df833deb0)
