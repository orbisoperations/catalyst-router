# Aspire Dashboard OTel Verification — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Aspire Dashboard as an opt-in Docker Compose override to verify OTel attribute naming follows conventions.

**Architecture:** Two new files, zero existing files modified. A compose override adds the Aspire Dashboard service and extends the OTel Collector to load a second config file. The OTel Collector supports multiple `--config` flags with deep merge, so the second config only contains the Aspire exporter and updated pipeline definitions. When the override isn't used, there's no impact — no log noise, no failed exports.

**Tech Stack:** Docker Compose, OTel Collector (`--config` merge), .NET Aspire Dashboard

**Spec:** `docs/superpowers/specs/2026-03-10-aspire-dashboard-otel-verification-design.md`

---

## Chunk 1: Add Aspire Dashboard

### Task 1: Create collector config extension and compose override

**Files:**

- Create: `docker-compose/otel-collector-aspire.yaml`
- Create: `docker-compose/aspire.compose.yaml`

**Context:**

The existing collector config (`otel-collector-config.yaml`) has these pipelines:

```yaml
pipelines:
  traces:
    exporters: [debug, otlphttp/jaeger]
  metrics:
    exporters: [debug, prometheusremotewrite]
  logs:
    exporters: [debug, otlphttp/loki]
```

The OTel Collector merges multiple `--config` files by deep-merging maps but **replacing** lists. So the extension config must repeat the full pipeline definitions (including existing exporters) plus the new Aspire exporter.

Aspire Dashboard accepts OTLP over gRPC on port 18889 by default. Use the `otlp` (gRPC) exporter, not `otlphttp` (HTTP). gRPC exporters use `endpoint` without protocol prefix and need `tls.insecure: true` for non-TLS.

- [ ] **Step 1: Create `docker-compose/otel-collector-aspire.yaml`**

```yaml
# Aspire Dashboard exporter extension
# Merged with base config via: --config otel-collector-config.yaml --config otel-collector-aspire.yaml
# Note: OTel Collector replaces lists (not appends), so pipelines repeat all exporters.

exporters:
  otlp/aspire:
    endpoint: aspire-dashboard:18889
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug, otlphttp/jaeger, otlp/aspire]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug, prometheusremotewrite, otlp/aspire]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug, otlphttp/loki, otlp/aspire]
```

- [ ] **Step 2: Create `docker-compose/aspire.compose.yaml`**

```yaml
# Aspire Dashboard override — use with:
#   docker compose -f docker.compose.yaml -f aspire.compose.yaml up

services:
  aspire-dashboard:
    image: mcr.microsoft.com/dotnet/aspire-dashboard:latest
    container_name: catalyst-aspire-dashboard
    ports:
      - '18888:18888'
    environment:
      - DOTNET_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=true

  otel-collector:
    command:
      - '--config'
      - '/etc/otel-collector-config.yaml'
      - '--config'
      - '/etc/otel-collector-aspire.yaml'
    volumes:
      - ./otel-collector-aspire.yaml:/etc/otel-collector-aspire.yaml
```

Note: Docker Compose merges `volumes` lists from overrides (appends), so the base config volume mount is preserved. The `command` is replaced entirely, which is what we want.

- [ ] **Step 3: Validate compose config**

Run: `cd docker-compose && docker compose -f docker.compose.yaml -f aspire.compose.yaml config --services`

Expected output should include all existing services plus `aspire-dashboard`.

- [ ] **Step 4: Commit**

```bash
git add docker-compose/otel-collector-aspire.yaml docker-compose/aspire.compose.yaml
gt modify -c --no-interactive -m "feat(docker): add opt-in Aspire Dashboard for OTel verification"
```

- [ ] **Step 5: Manual verification (when ready)**

```bash
cd docker-compose
docker compose -f docker.compose.yaml -f aspire.compose.yaml up
```

Open `http://localhost:18888` — the Aspire Dashboard should show:

- **Structured Logs** tab: log records with `catalyst.event.outcome`, `catalyst.event.duration_ms`, `catalyst.orchestrator.*` attributes rendered as structured fields
- **Traces** tab: spans with proper hierarchy and OTel-standard attributes
- **Metrics** tab: metrics with expected names

Verify against the checklist in the design spec.
