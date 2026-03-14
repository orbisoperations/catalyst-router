# PR Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address unresolved PR review feedback across PRs #506 and #511.

**Architecture:** Six targeted fixes — four in the dashboard route file, one Dockerfile/compose security fix, and one compose overlay extraction. Items 1-4 touch the same file so they're grouped into one task.

**Tech Stack:** TypeScript, Hono, Docker Compose, Alpine Linux

**Spec:** `docs/superpowers/specs/2026-03-11-pr-review-fixes-design.md`

---

## Chunk 1: Dashboard route fixes

### Task 1: Fix dashboard.ts — rename, immutability, env vars, warning log

All four dashboard review items touch `apps/orchestrator/src/routes/dashboard.ts`. The v2 bus also needs the immutability fix at its call site.

**Files:**

- Modify: `apps/orchestrator/src/routes/dashboard.ts` (items 1, 3, 4)
- Modify: `apps/orchestrator/src/v1/orchestrator.ts:1072-1074` (item 2)
- Modify: `apps/orchestrator/src/v2/catalyst-service.ts:163` (item 2 — v2 call site)

#### Item 1: Rename `latencyMs` to `durationMs`

- [ ] **Step 1: Rename in `ServiceHealth` interface**

In `apps/orchestrator/src/routes/dashboard.ts`, change line 28:

```typescript
// Before
interface ServiceHealth extends ServiceDef {
  status: 'up' | 'down' | 'unknown'
  latencyMs?: number
  error?: string
}

// After
interface ServiceHealth extends ServiceDef {
  status: 'up' | 'down' | 'unknown'
  durationMs?: number
  error?: string
}
```

- [ ] **Step 2: Update both assignments in `checkHealth()`**

Lines 96 and 102 — replace `latencyMs` with `durationMs`:

```typescript
// Line 96 (success path)
durationMs: Math.round(performance.now() - start),

// Line 102 (error path)
durationMs: Math.round(performance.now() - start),
```

- [ ] **Step 3: Verify no other references to `latencyMs`**

Run: `grep -r 'latencyMs' apps/orchestrator/src/`

Expected: No matches. The dashboard frontend reads this as JSON so it will need updating separately if it references the field name, but that's in `apps/web-ui/` which is a separate concern.

#### Item 2: Make `getState()` return immutable copy

- [ ] **Step 4: Fix v1 orchestrator `getState()`**

In `apps/orchestrator/src/v1/orchestrator.ts`, change lines 1071-1074:

```typescript
// Before
/** Read-only snapshot of the route table for the dashboard. */
getState(): RouteTable {
  return this.state
}

// After
/** Read-only snapshot of the route table for the dashboard. */
getState(): RouteTable {
  return structuredClone(this.state)
}
```

- [ ] **Step 5: Fix v2 bus call site**

In `apps/orchestrator/src/v2/catalyst-service.ts`, change line 163:

```typescript
// Before
createDashboardRoutes({ getState: () => bus.state }, this.config)

// After
createDashboardRoutes({ getState: () => structuredClone(bus.state) }, this.config)
```

#### Item 3: Warn when envoy config is missing

- [ ] **Step 6: Add logger import and warning in `createDashboardRoutes()`**

In `apps/orchestrator/src/routes/dashboard.ts`, add import at top:

```typescript
import { getLogger } from '@catalyst/telemetry'
```

Then in `createDashboardRoutes()` (after line 111), add:

```typescript
const logger = getLogger(['catalyst', 'dashboard'])

if (!config.orchestrator?.envoyConfig?.endpoint) {
  logger.warning('Envoy config not set — envoy-service will not appear in dashboard', {
    'event.name': 'dashboard.envoy_config.missing',
  })
}
```

#### Item 4: Move `process.env` reads to route setup time

- [ ] **Step 7: Add params to `deriveServiceGroups` and read env vars in `createDashboardRoutes`**

Change the `deriveServiceGroups` signature to accept the two values as params:

```typescript
// Before (line 46)
function deriveServiceGroups(config: CatalystConfig): { name: string; services: ServiceDef[] }[] {
  const port = config.port ?? 3000
  const nodeId = config.node.name
  const otelName = process.env.OTEL_SERVICE_NAME ?? nodeId

  // ... line 55
  const authEndpoint = config.orchestrator?.auth?.endpoint ?? process.env.CATALYST_AUTH_ENDPOINT

// After
interface DeriveOptions {
  config: CatalystConfig
  otelServiceName: string
  authEndpointFallback?: string
}

function deriveServiceGroups({ config, otelServiceName, authEndpointFallback }: DeriveOptions): { name: string; services: ServiceDef[] }[] {
  const port = config.port ?? 3000
  const otelName = otelServiceName

  // ...
  const authEndpoint = config.orchestrator?.auth?.endpoint ?? authEndpointFallback
```

Then in `createDashboardRoutes()`, read env vars once and pass them:

```typescript
export function createDashboardRoutes(bus: DashboardStateProvider, config: CatalystConfig): Hono {
  const app = new Hono()

  const otelServiceName = process.env.OTEL_SERVICE_NAME ?? config.node.name
  const authEndpointFallback = process.env.CATALYST_AUTH_ENDPOINT

  // ... logger + warning from step 6 ...

  const serviceGroups = deriveServiceGroups({ config, otelServiceName, authEndpointFallback })
```

- [ ] **Step 8: Verify the orchestrator builds**

Run: `pnpm --filter orchestrator exec tsc --noEmit`

Expected: No type errors.

- [ ] **Step 9: Commit dashboard fixes**

```bash
git add apps/orchestrator/src/routes/dashboard.ts apps/orchestrator/src/v1/orchestrator.ts apps/orchestrator/src/v2/catalyst-service.ts
gt modify --no-interactive -c -m "fix(dashboard): address PR #506 review feedback

- Rename latencyMs to durationMs (accuracy)
- Return structuredClone from getState() (immutability)
- Warn when envoy config missing (visibility)
- Move process.env reads to init time (best practice)"
```

---

## Chunk 2: Auth Dockerfile security fix

### Task 2: Replace `user: root` with entrypoint that drops privileges

**Files:**

- Create: `apps/auth/docker-entrypoint.sh`
- Modify: `apps/auth/Dockerfile:55-68`
- Modify: `docker-compose/two-node.compose.yaml:23`

- [ ] **Step 1: Create entrypoint script**

Create `apps/auth/docker-entrypoint.sh`:

```sh
#!/bin/sh
set -e

# Fix volume ownership (Docker creates named volumes as root)
chown appuser:appgroup /data

# Drop privileges and exec the application
exec su-exec appuser node server.mjs
```

- [ ] **Step 2: Update Dockerfile runtime stage**

In `apps/auth/Dockerfile`, replace lines 54-68:

```dockerfile
# Runtime stage
FROM node:22-alpine
WORKDIR /app

# su-exec for privilege dropping in entrypoint
RUN apk add --no-cache su-exec

COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /app/dist/server.mjs ./server.mjs
COPY apps/auth/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PORT=5000
EXPOSE 5000

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN mkdir -p /data && chown appuser:appgroup /data

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
```

Note: `CMD` is kept for documentation but the entrypoint ignores it — it always runs `node server.mjs`. Remove the `USER appuser` line since the entrypoint handles privilege dropping.

- [ ] **Step 3: Remove `user: root` from two-node compose**

In `docker-compose/two-node.compose.yaml`, delete line 23:

```yaml
# Before
auth:
  build:
    context: ..
    dockerfile: apps/auth/Dockerfile
  user: root # <-- delete this line
  ports:
```

- [ ] **Step 4: Verify auth image builds**

Run: `docker build -f apps/auth/Dockerfile -t catalyst-auth-test ..` (from repo root)

Expected: Build succeeds.

- [ ] **Step 5: Commit auth security fix**

```bash
git add apps/auth/docker-entrypoint.sh apps/auth/Dockerfile docker-compose/two-node.compose.yaml
gt modify --no-interactive -c -m "fix(auth): drop user:root — use entrypoint for privilege drop

Add docker-entrypoint.sh that chowns /data then drops to appuser
via su-exec. Removes user:root override from two-node compose."
```

---

## Chunk 3: Extract observability to compose overlay

### Task 3: Create `observability.compose.yaml` and remove duplicated services

**Files:**

- Create: `docker-compose/observability.compose.yaml`
- Modify: `docker-compose/docker.compose.yaml:202-265` (remove observability services + volumes)
- Modify: `docker-compose/two-node.compose.yaml:259-323` (remove observability services + volumes)

- [ ] **Step 1: Create the observability overlay**

Create `docker-compose/observability.compose.yaml`:

```yaml
# Observability backends — opt-in overlay
# Usage: docker compose -f docker.compose.yaml -f observability.compose.yaml up
services:
  prometheus:
    image: prom/prometheus:v3.2.1
    ports:
      - '9090:9090'
    volumes:
      - ./prometheus.yaml:/etc/prometheus/prometheus.yml:ro
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--web.enable-remote-write-receiver'
      - '--storage.tsdb.retention.time=7d'
    depends_on:
      otel-collector:
        condition: service_started

  jaeger:
    image: jaegertracing/jaeger:2.5.0
    ports:
      - '16686:16686'
    environment:
      - COLLECTOR_OTLP_ENABLED=true
    depends_on:
      otel-collector:
        condition: service_started

  loki:
    image: grafana/loki:3.4.2
    ports:
      - '3100:3100'
    command: ['-config.file=/etc/loki/loki.yaml']
    volumes:
      - ./loki-config.yaml:/etc/loki/loki.yaml:ro
      - loki-data:/loki
    depends_on:
      otel-collector:
        condition: service_started

  grafana:
    image: grafana/grafana-oss:11.5.2
    ports:
      - '3050:3000'
    environment:
      - GF_SECURITY_ALLOW_EMBEDDING=true
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer
      - GF_USERS_VIEWERS_CAN_EDIT=true
    volumes:
      - ./grafana/provisioning:/etc/grafana/provisioning
      - grafana-data:/var/lib/grafana
    depends_on:
      prometheus:
        condition: service_started
      jaeger:
        condition: service_started
      loki:
        condition: service_started

volumes:
  prometheus-data:
  loki-data:
  grafana-data:
```

- [ ] **Step 2: Remove observability services from `docker.compose.yaml`**

Delete lines 202-265 (the `# --- Observability visualization ---` comment through end of file). Replace with just the volumes that are still needed by the base services:

```yaml
volumes:
  auth-data:
```

The `prometheus-data`, `loki-data`, and `grafana-data` volumes move to the overlay.

- [ ] **Step 3: Remove observability services from `two-node.compose.yaml`**

Delete lines 259-323 (the `# --- Observability backends ---` comment through end of file). Replace with just:

```yaml
volumes:
  auth-data:
```

- [ ] **Step 4: Verify compose files parse correctly**

Run both:

```bash
docker compose -f docker-compose/docker.compose.yaml config --quiet
docker compose -f docker-compose/docker.compose.yaml -f docker-compose/observability.compose.yaml config --quiet
docker compose -f docker-compose/two-node.compose.yaml config --quiet
docker compose -f docker-compose/two-node.compose.yaml -f docker-compose/observability.compose.yaml config --quiet
```

Expected: All exit 0 with no errors.

- [ ] **Step 5: Commit observability extraction**

```bash
git add docker-compose/observability.compose.yaml docker-compose/docker.compose.yaml docker-compose/two-node.compose.yaml
gt modify --no-interactive -c -m "refactor(docker): extract observability stack to compose overlay

Move prometheus, jaeger, loki, grafana to observability.compose.yaml.
Eliminates duplication between docker.compose.yaml and two-node.compose.yaml.
Usage: docker compose -f docker.compose.yaml -f observability.compose.yaml up"
```
