# Stack Overview: Structured Logging, Dashboard Extraction & Hardening

**Date:** 2026-03-09
**Stack:** PRs #534–#577

This document captures the design rationale behind the work in this stack. The code is the source of truth for implementation details; this covers the _why_ and the conventions established for future contributors.

## 1. Structured Logging & Wide Events

### Problem

All logging used LogTape template literals:

```typescript
this.logger.info`Dispatching action: ${sentAction.action}`
```

Values were baked into the message string — not queryable as structured fields. The OTLP pipeline (LogTape → OTel Collector → Loki) already forwards `record.properties` as log record attributes, but nobody was using properties. Operators couldn't answer questions like "why did peer X disconnect?" or "how long does route convergence take?" without SSH access.

### Solution

Two complementary patterns:

1. **Wide events** — One canonical structured event per unit of work, emitted at completion with 20-50+ fields. Implemented as a `WideEvent` class in `@catalyst/telemetry` that accumulates fields and emits once. Modeled after [Stripe's canonical log lines](https://stripe.com/blog/canonical-log-lines) and [wide events](https://loggingsucks.com).

2. **Structured state transition logs** — Individual log lines for important state changes (peer connect/disconnect, route advertise/withdraw), using `logger.info("message {key}", { key: value })` which keeps the human-readable message AND sends properties as discrete OTel attributes.

Integration points: Hono HTTP middleware (gateway, auth), orchestrator action dispatch, Envoy xDS snapshot push, Node RPC calls.

~90 template literal log calls were migrated across orchestrator, gateway, auth, envoy, and node packages. Logs redundant with the wide event (e.g. "received request") were removed rather than converted.

### WideEvent Pure Accumulation (Option A)

All WideEvent call sites follow the "pure accumulation" pattern: no intermediate `logger.*` calls within a WideEvent scope. Everything goes through `event.set()`, and `emit()` is called in a `finally` block.

**Rationale:** The codebase already has OTel distributed tracing (Jaeger). Traces provide the step-by-step narrative of an operation (spans with timing, parent-child relationships, error recording). Adding log-level correlation would duplicate what traces already provide. Logs are the **summary layer** (what happened, how long, did it succeed); traces are the **narrative layer** (step-by-step detail).

**Operator workflow:**

1. Loki: query by `event.name`, see summary record with outcome, duration, key fields
2. Need step-by-step? Click `trace_id` on the log record → Jaeger shows the full span tree

The HTTP middleware (`packages/telemetry/src/middleware/wide-event.ts`) is the gold standard reference implementation.

### Wide Event Catalog

| Service      | event.name                       | Key fields                                                                 |
| ------------ | -------------------------------- | -------------------------------------------------------------------------- |
| orchestrator | `orchestrator.action`            | `action.type`, `peer.name`, `route.change_count`, `route.total`            |
| orchestrator | `orchestrator.peer_sync`         | `peer.name`, `sync.type`, `sync.route_count`                               |
| orchestrator | `orchestrator.route_propagation` | `peer.connected_count`, `route.change_count`, `peer.failed_count`          |
| orchestrator | `transport.open_peer`            | `peer.name`, `peer.endpoint`                                               |
| gateway      | `gateway.reload`                 | `gateway.service_count`, `gateway.subgraph_count`, `gateway.zero_services` |
| gateway      | `http.request`                   | `http.method`, `http.route`, `http.status_code`                            |
| auth         | `http.request`                   | `auth.operation`, `auth.token_type`, `auth.subject`                        |
| envoy        | `envoy.route_update`             | `envoy.route_count`, `xds.clusters_added`, `xds.clusters_removed`          |
| node         | `rpc.call`                       | `rpc.method`, `rpc.status`                                                 |

### State Transition Log Catalog

| event.name              | Service      | When                                        |
| ----------------------- | ------------ | ------------------------------------------- |
| `peer.session.opened`   | orchestrator | Peer connected                              |
| `peer.session.closed`   | orchestrator | Peer disconnected (includes `close.reason`) |
| `route.advertised`      | orchestrator | Route pushed to peer                        |
| `route.withdrawn`       | orchestrator | Route removed from peer                     |
| `route.installed`       | orchestrator | Route added to local table                  |
| `token.minted`          | auth         | New JWT issued                              |
| `token.refresh.failed`  | auth         | Token refresh failed                        |
| `xds.client.subscribed` | envoy        | New xDS subscription                        |
| `xds.client.acked`      | envoy        | Client ACK received                         |

### OTel Attribute Naming Convention

PR review feedback identified that custom attributes need a domain namespace to avoid collisions with OTel semantic conventions. All custom attributes follow:

```
catalyst.<component>.<property>
```

- `catalyst` — product namespace (matches `@catalyst/*` packages)
- `<component>` — emitting service (e.g. `orchestrator`, `gateway`, `event`)
- `<property>` — dot-delimited, snake_case for multi-word

Standard OTel attributes (`exception.*`, `http.*`, `url.*`, `event.name`) are unchanged.

**Core attributes:**

| Attribute                    | Purpose         |
| ---------------------------- | --------------- |
| `catalyst.event.outcome`     | success/failure |
| `catalyst.event.duration_ms` | elapsed time    |

**Orchestrator attributes:**

| Attribute                             | Purpose                                               |
| ------------------------------------- | ----------------------------------------------------- |
| `catalyst.orchestrator.action.type`   | dispatched action                                     |
| `catalyst.orchestrator.peer.name`     | peer node name                                        |
| `catalyst.orchestrator.peer.endpoint` | peer connection URL                                   |
| `catalyst.orchestrator.route.*`       | route change counts (added, removed, modified, total) |
| `catalyst.orchestrator.sync.type`     | sync operation type                                   |
| `catalyst.orchestrator.reconnect.*`   | reconnection attempt/delay                            |
| `catalyst.orchestrator.node.name`     | local node name                                       |

**Convention for new services:** `catalyst.<service>.<property>` — e.g. `catalyst.gateway.upstream.host`, `catalyst.node.stream.protocol`.

## 2. Dashboard Extraction

### Problem

The web dashboard was embedded in the orchestrator process. When the orchestrator restarted, the dashboard went down too. Suggestion from Jae: extract it so operators always have visibility.

### Solution

Standalone `apps/web-ui` — a thin Hono server (~50 lines) that:

- Serves the built React SPA at `/`
- Proxies `/api/*` to `${ORCHESTRATOR_URL}/dashboard/api/*`
- Exposes its own `/health`

```
Browser → web-ui (port 8080) → orchestrator (port 3000)
            │                          │
            ├── serves React SPA       ├── /dashboard/api/state
            ├── /api/* (proxy)         ├── /dashboard/api/services
            └── /health                └── /dashboard/api/config
```

**Key decisions:**

- **HTTP REST + polling** (not WebSocket) — Grafana standard, configurable poll intervals, no persistent connection management
- **No peer failover in v1** — if orchestrator is down, dashboard shows it as unreachable; operators check the other node's dashboard directly
- **Thin backend, not static SPA** — backend proxy avoids CORS and host-URL configuration issues

The frontend moved from `apps/orchestrator/frontend/` to `apps/web-ui/frontend/`. The orchestrator's dashboard API routes stay in the orchestrator (they became internal API). Frontend fetch URLs changed from `/dashboard/api/*` to `/api/*` since the proxy handles routing.

## 3. Views.ts Refactor

The `packages/routing/src/v2/views.ts` file used 3 classes (`PeerView`, `InternalRouteView`, `RouteTableView`) to strip sensitive fields (peer tokens, internal bookkeeping) from API responses. These were replaced with plain functions (`toPublicPeer`, `toPublicInternalRoute`, `toDataChannel`, `toPublicRouteTable`, `internalRouteCount`) and zod-derived types.

**Rationale:** The classes added unnecessary indirection for what are simple field-stripping transforms. Plain functions are easier to compose and test. The `PublicPeer` type is now derived from `PeerRecordSchema.omit()`, giving zod-based validation instead of hand-written `Omit<>` types.

## 4. Dashboard Links Config File

The `CATALYST_DASHBOARD_LINKS` env var contained a JSON blob with URL-encoded JSON nested inside — unreadable and duplicated across `docker.compose.yaml` and `two-node.compose.yaml`.

Replaced with `CATALYST_DASHBOARD_LINKS_FILE` pointing to a mounted `docker-compose/dashboard-links.json` file. Single source of truth, human-readable. The config package's `loadDashboardLinks()` handles both file and env var with clear precedence:

1. `CATALYST_DASHBOARD_LINKS_FILE` set → read file, throw on missing/invalid
2. `CATALYST_DASHBOARD_LINKS` set → parse inline JSON, throw on invalid
3. Neither → `undefined` (optional feature)

Error handling is now consistent: always throw on invalid input (the web-ui previously warned and continued, hiding broken config from operators).

## 5. Review Hardening

Items addressed from PR review feedback:

| Change                                   | Rationale                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `latencyMs` → `durationMs`               | `performance.now()` measures wall-clock elapsed time including event loop delay, DNS, TLS, server processing — not pure network latency. `durationMs` is accurate and consistent with OTel conventions. |
| `getState()` returns `structuredClone()` | Was documented as "read-only snapshot" but returned the live object. Callers could mutate the route table bypassing `dispatch()`. Dashboard API is low-frequency so clone cost is negligible.           |
| Warn on missing envoy config             | Dashboard conditionally includes envoy-service but operators had no visibility when envoy config was absent. Added warning log.                                                                         |
| `process.env` reads moved to init time   | `deriveServiceGroups()` read env vars on every API call. Env vars should be resolved once at setup.                                                                                                     |
| Remove `user: root` from auth compose    | Auth Dockerfile creates a non-root `appuser` but compose overrode with `user: root` for volume ownership. Added entrypoint that starts as root, fixes ownership, then drops to `appuser` via `su-exec`. |
| Observability stack → compose overlay    | Prometheus/Jaeger/Loki/Grafana were duplicated across compose files. Extracted to `observability.compose.yaml` (same pattern as `aspire.compose.yaml`).                                                 |

### Review Items Not Actioned

| Item                               | Reason                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| PR #510 `process.env.FRONTEND_DIR` | Already resolved by web-ui extraction (PR #534)                                                                |
| PR #522 holocrons subskill         | Process concern, already replied to by author                                                                  |
| PR #561 `otlp_grpc` naming         | Reviewer incorrect — `otlp_grpc` is the canonical name as of collector v0.144.0 (upstream renamed from `otlp`) |
| PR #506 "GQL doesn't matter"       | Informational comment, no action needed                                                                        |

## 6. Aspire Dashboard

Added .NET Aspire Dashboard as an opt-in compose profile (`--profile aspire`) for verifying OTel attribute naming. Aspire accepts OTLP directly and renders all three signals in an OTel-native UI — useful for catching attribute naming issues that Grafana might mask. Stores data in-memory, no persistence. Verification tool, not a Grafana replacement.

Alternatives considered and rejected: SigNoz (requires swapping entire backend to ClickHouse), Uptrace (BSL license concern), VictoriaMetrics/InfluxDB (storage engines, still use Grafana for UI).

## 7. Future Work: Comprehensive Node Logging

This stack established the logging infrastructure and conventions. The next phase would add ~45 additional event types to achieve full diagnostic coverage without SSH access. See the [Node Logs Notion ticket](https://www.notion.so/31947ad1da7980c581d2e93b1f5a4674) for details.
