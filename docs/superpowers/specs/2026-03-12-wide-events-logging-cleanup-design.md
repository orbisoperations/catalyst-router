# Wide Events / Logging Cleanup Design

## Problem Statement

WideEvent is used across the codebase but only one call site (HTTP middleware) follows the intended "wide event" pattern — a single structured log record per operation that tells the full story. All other call sites emit intermediate `logger.info/warn/error` calls alongside the WideEvent, producing multiple uncorrelated log records per operation. This makes it impossible to reconstruct an operation from a single record in Loki.

Additionally, several related cleanup items from code review and the Notion task tracker need to be addressed in the same sweep.

## Design Decision: Option A (Pure Accumulation)

**Decision:** No intermediate logs within a WideEvent scope. Everything goes through `event.set()`. The final WideEvent record tells the full story.

**Rationale:** The codebase already has OTel distributed tracing (Jaeger). Traces provide the step-by-step narrative of an operation (spans with timing, parent-child relationships, error recording). Adding log-level correlation (Option B's `wide_event.id`) would duplicate what traces already provide. Logs should be a **summary layer** (what happened, how long, did it succeed), and traces should be the **narrative layer** (step-by-step).

**Workflow for operators:**

1. Loki: query by `event.name`, see summary record with outcome, duration, key fields
2. Need step-by-step? Click `trace_id` on the log record → Jaeger shows the full span tree

## Scope

### In Scope

1. **WideEvent Option A cleanup** — convert all call sites to pure accumulation pattern
2. **views.ts → plain functions + zod w/ Omit** — replace class wrappers with functions
3. **CATALYST_DASHBOARD_LINKS → config file** — replace messy JSON env var with a mounted config file

### Out of Scope

- **OTel semconv ATTR\_\* constants migration** — ~290 occurrences, separate dedicated PR
- **Grafana auth security hardening** — separate task, noted on Notion page as "will wrap in another dedicated auth space"
- **Fonts from design system** — frontend concern, separate task
- **PR #506 import path fix** — already fixed (replaced with `DashboardStateProvider` interface)
- **PR #506 peer token leak** — already fixed (v1: `stripPeerToken` helper, v2: view classes)
- **PR replies** — will be done after implementation

## 1. WideEvent Option A Cleanup

### Gold Standard Pattern

The HTTP middleware (`packages/telemetry/src/middleware/wide-event.ts`) is the reference implementation:

- WideEvent created at start of operation
- All data accumulated via `event.set()`
- `emit()` called in a `finally` block (guarantees emission)
- Zero intermediate `logger.*` calls

### Pattern Applied to Every Call Site

1. Delete intermediate `logger.info/warn/error` calls within WideEvent scope
2. Fold any unique data from those logs into `event.set()`
3. Wrap in `try/finally` so `emit()` always fires
4. Add `setError()` in catch blocks where missing

### Call Site Changes

#### Gateway: `gateway.reload` (`apps/gateway/src/graphql/server.ts`)

**Current:** 4 intermediate logs in reload method + 2 in `validateServiceSdl()` subroutine. Three separate `emit()` calls at different exit paths. No `finally`.

**Changes:**

- Remove `logger.info('Reloading gateway...')` — event.name already identifies the operation
- Remove `logger.warn('No services configured...')` — fold into `event.set('gateway.zero_services', true)`
- Remove `logger.info('Gateway reloaded successfully...')` — WideEvent emit covers this
- Remove `logger.error('Gateway reload failed...')` — `setError()` already captures this
- Remove `logger.info('SDL validated...')` and `logger.warn('SDL validation failed...')` in `validateServiceSdl()` — fold validation status into WideEvent via `event.set('gateway.sdl_valid', boolean)` per subgraph, or let the thrown error surface to the WideEvent's catch block
- Consolidate to single `emit()` in `finally` block

#### Envoy: `envoy.route_update` (`apps/envoy/src/rpc/server.ts`)

**Current:** 6 intermediate logs. Two `emit()` calls at different exit paths. No `finally`.

**Changes:**

- Remove `logger.info('Route update received...')` — event.name identifies the operation
- Remove `logger.error('Malformed route config...')` — `setError()` captures this
- Remove `logger.info('Stored N routes...')` — data already in `event.set()` calls
- Remove `logger.warn('No portAllocations...')` — fold into `event.set('envoy.legacy_port_derivation', true)`
- Remove `logger.info('xDS config diff...')` — fold `xds.clusters_added` and `xds.clusters_removed` into `event.set()`
- Remove `logger.info('xDS snapshot pushed...')` — data already in `event.set()` calls
- Consolidate to single `emit()` in `finally` block

#### Orchestrator v2: `transport.open_peer` (`apps/orchestrator/src/v2/ws-transport.ts`)

**Current:** 1 intermediate log. Three `emit()` calls at different exit paths. No `finally`.

**Changes:**

- Remove `logger.info('Opened connection to...')` — peer name already in WideEvent fields
- Consolidate to single `emit()` in `finally` block

#### Orchestrator v2: `orchestrator.action` (`apps/orchestrator/src/v2/bus.ts`)

**Current:** 1 intermediate log. Two `emit()` calls. No `finally`. No error handling.

**Changes:**

- Remove `logger.info('Route table changed...')` — change counts already in WideEvent fields
- Fold `catalyst.orchestrator.route.trigger` into `event.set()`
- Add try/catch/finally with `setError()` and single `emit()`

#### Orchestrator v2: `orchestrator.peer_sync` (`apps/orchestrator/src/v2/bus.ts`)

**Current:** 1 intermediate log in `handleBGPNotify`. Additionally, `syncRoutesToPeer()` (called within this WideEvent scope) contains 3 more intermediate logs at lines 254, 263, 269 (`route.sync.empty`, `route.sync.completed`, `peer.sync.initial_failed`). Single `emit()` call. No try/catch at all — exceptions prevent emit.

**Changes:**

- Remove `logger.info('Peer connected, syncing...')` — peer name already in WideEvent fields
- Remove the 3 intermediate logs inside `syncRoutesToPeer()` — fold route count and sync result into `event.set()`
- Change `syncRoutesToPeer()` to return `{ routeCount: number }` (currently returns `void`) so the WideEvent can capture the result
- Add try/catch/finally with `setError()` and single `emit()`

#### Orchestrator v2: `orchestrator.route_propagation` (`apps/orchestrator/src/v2/bus.ts`)

**Current:** Per-peer failure logs in a loop. Single `emit()`. No outcome tracking — partial failures report as success.

**Changes:**

- Remove per-peer `logger.warn('Failed to send...')` calls
- Add `event.set('catalyst.orchestrator.peer.failed_count', failedCount)` as summary
- Set outcome to `'partial_failure'` or `'failure'` based on results
- Add try/finally around the whole block

#### Orchestrator v1: `orchestrator.action` (`apps/orchestrator/src/v1/orchestrator.ts`)

**Current:** 3 intermediate logs directly in `dispatch()` (lines 240, 249, 275). Additionally, `handleAction()` is called synchronously within the WideEvent scope and contains many more `logger.*` calls throughout its branches (e.g., `InternalProtocolUpdate` logging, loop detection debug, unknown action warn). Two `emit()` calls. No `finally`.

**Changes — minimal cleanup only (v1 is being superseded by v2):**

- Remove the 3 direct intermediate logs in `dispatch()`: `logger.info('Dispatching action...')`, `logger.debug('Route create data...')`, `logger.error('Action failed...')`
- Leave `handleAction()` internal logs as-is — deep refactoring of v1 is not justified since v2 is the successor
- Leave async `handleNotify` failure log as-is (fires after emit, separate concern)
- Add try/finally with single `emit()`

## 2. views.ts → Plain Functions + Zod

**File:** `packages/routing/src/v2/views.ts`

### Current Structure

- 3 classes: `PeerView`, `InternalRouteView`, `RouteTableView`
- 3 type aliases: `PublicPeer`, `PublicInternalRoute`, `PublicRouteTable` (hand-written `Omit<>` types)
- Classes manually destructure records to strip sensitive/internal fields
- No zod usage despite underlying data having zod schemas

### New Structure

Replace classes with zod-derived schemas and plain functions:

**Schemas (derived from existing zod schemas):**

- `PublicPeerSchema` = `PeerRecordSchema.omit({ peerToken, holdTime, lastSent, lastReceived })`
- `PublicInternalRouteSchema` — Note: `InternalRoute` is a plain TypeScript type alias (`DataChannelDefinition & { peer, nodePath, originNode, isStale? }`), not a zod schema. Create `InternalRouteSchema` by extending `DataChannelDefinitionSchema` with the additional fields, then derive `PublicInternalRouteSchema` via `.omit()`. Alternatively, if creating the full schema is too heavy, use manual field stripping in the function (as today) and keep `PublicInternalRoute` as a TypeScript `Omit<>` type rather than `z.infer<>`.
- `PublicRouteTableSchema` = composite schema (or plain TypeScript type if `InternalRouteSchema` is not created)

**Functions:**

- `toPublicPeer(peer: PeerRecord): PublicPeer`
- `toPublicInternalRoute(route: InternalRoute): PublicInternalRoute`
- `toDataChannel(route: InternalRoute): DataChannelDefinition`
- `toPublicRouteTable(table: RouteTable): PublicRouteTable`
- `internalRouteCount(table: RouteTable): number`

**Types:** `PublicPeer`, `PublicInternalRoute`, `PublicRouteTable` become `z.infer<>` of their schemas.

**Dropped:** `PeerView.name` and `InternalRouteView.name` getters (unused outside classes).

### Consumer Updates

- `bus.ts`: `new RouteTableView(x).internalRouteCount` → `internalRouteCount(x)`
- `bus.ts`: `new InternalRouteView(r).toDataChannel()` → `toDataChannel(r)`
- `rpc.ts`: `new PeerView(p).toPublic()` → `toPublicPeer(p)`
- `rpc.ts`: `new InternalRouteView(r).toPublic()` → `toPublicInternalRoute(r)`
- `catalyst-service.ts`: `new RouteTableView(s).toPublic()` → `toPublicRouteTable(s)`
- `views.test.ts`: update to test functions directly

## 3. CATALYST_DASHBOARD_LINKS → Config File

### Current Problems

- JSON blob in env var with URL-encoded JSON nested inside (unreadable)
- Duplicated across `docker.compose.yaml` and `two-node.compose.yaml`
- Inconsistent error handling: config package throws, web-ui warns

### New Approach

**Config file:** `docker-compose/dashboard-links.json` — single source of truth, mounted into containers.

```json
{
  "metrics": "http://localhost:3050/d/catalyst-services?var-service={service}",
  "traces": "http://localhost:3050/explore?...",
  "logs": "http://localhost:3050/explore?..."
}
```

**Env var:** `CATALYST_DASHBOARD_LINKS_FILE` points to the mounted file path. Fall back to `CATALYST_DASHBOARD_LINKS` inline JSON for backward compatibility.

**Precedence and error handling:**

1. If `CATALYST_DASHBOARD_LINKS_FILE` is set → read the file. If file is missing or unreadable, **throw** (this is a misconfiguration, not a graceful degradation case). If JSON is invalid, **throw**.
2. If `CATALYST_DASHBOARD_LINKS_FILE` is not set → fall back to `CATALYST_DASHBOARD_LINKS` env var. If present, parse as JSON; throw on invalid JSON.
3. If neither is set → dashboard links are `undefined` (optional feature).
4. If both are set → `_FILE` takes precedence, `CATALYST_DASHBOARD_LINKS` is ignored.

**Unified error behavior:** Always throw on invalid input. The web-ui's current "warn and continue" behavior is a bug — if the operator configured links and they're broken, they should know immediately, not discover it later when the UI shows no links.

**Code changes:**

- `packages/config/src/index.ts`: add file-based loading with the precedence rules above. Validate with `DashboardConfigSchema`.
- `apps/web-ui/src/server.ts`: use the config package's loader instead of its own JSON parsing. Eliminates inconsistent error handling.
- Docker compose files: mount `dashboard-links.json`, set `CATALYST_DASHBOARD_LINKS_FILE` env var, remove inline JSON.

## PR Structure

PRs are stacked in this order. Each PR builds on the previous.

| PR  | Content                                     | Notes                                                                                                                |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | views.ts → plain functions + zod            | Goes first because PR 3 touches the same consumers in bus.ts. After this PR, bus.ts uses the new function-based API. |
| 2   | WideEvent Option A: gateway cleanup         | Independent of PR 1                                                                                                  |
| 3   | WideEvent Option A: envoy cleanup           | Independent of PR 1                                                                                                  |
| 4   | WideEvent Option A: orchestrator v2 cleanup | Uses new function API from PR 1 in bus.ts                                                                            |
| 5   | WideEvent Option A: orchestrator v1 cleanup | Minimal cleanup only (v1 being superseded)                                                                           |
| 6   | CATALYST_DASHBOARD_LINKS → config file      | Independent of other PRs                                                                                             |

## Manual Verification Plan

After all PRs are implemented, verify with the full Docker Compose stack:

### 1. Start the stack

```bash
docker compose -f docker-compose/docker.compose.yaml up
```

### 2. Verify WideEvent pure accumulation

For each operation type, trigger the operation and check Loki:

- **Gateway reload**: Trigger a config push. Verify Loki shows exactly one `gateway.reload` record per reload with all fields (`gateway.service_count`, `gateway.subgraph_count`, `gateway.duration_ms`, outcome). No `gateway.reload.started`, `gateway.reloaded`, `gateway.reload.failed`, or `gateway.subgraph.sdl_validated` records.
- **Envoy route update**: Push a route config. Verify one `envoy.route_update` record with all fields including `xds.clusters_added`, `xds.clusters_removed`. No `envoy.route_update.received`, `envoy.routes.stored`, `xds.snapshot.pushed` records.
- **Orchestrator action**: Trigger a route change. Verify one `orchestrator.action` record. No `route.table.changed` records.
- **Orchestrator peer sync**: Connect a peer. Verify one `orchestrator.peer_sync` record with route count. No `peer.sync.started`, `route.sync.completed` records.
- **HTTP request**: Verify `http.request` records still work as before (gold standard, unchanged).

### 3. Verify error paths

- **Kill a peer mid-sync**: Verify `orchestrator.peer_sync` emits with `outcome=failure` and exception fields (tests `finally` block).
- **Send malformed route config**: Verify `envoy.route_update` emits with `outcome=failure`.
- **Partial peer failure**: Disconnect one peer, keep another connected, trigger route propagation. Verify `orchestrator.route_propagation` shows `peer.failed_count` and appropriate outcome.

### 4. Verify traces still correlate

- Pick any WideEvent log record in Loki, click the `trace_id` link, confirm Jaeger shows the full span tree for that operation.

### 5. Verify views.ts refactor

- Hit the orchestrator HTTP API (`/api/state` or equivalent) and verify the response shape is unchanged — no `peerToken`, `holdTime`, `lastSent`, `lastReceived` fields leaked.

### 6. Verify dashboard links from config file

- Confirm the web UI loads and shows correct Grafana links for metrics, traces, logs.
- Confirm links contain the correct `{service}` template substitution.
