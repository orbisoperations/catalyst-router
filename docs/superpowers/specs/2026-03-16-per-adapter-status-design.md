# Per-Adapter Status Page Design

**Status:** Proposed

**Date:** 2026-03-16

**Author:** Ian Hammerstrom

## Goal

Add health status visibility for all adapters (data channels) across the Catalyst mesh to the existing status page. Each node checks its own local adapters and propagates health data through the existing iBGP route advertisement mechanism.

## Context

The current status page (`apps/web-ui`) shows adapter presence (name, protocol, endpoint) but not whether adapters are actually healthy. The Catalyst SDK's `CatalystProducerServer` exposes a built-in `GET /health` endpoint, and some consumer adapters implement one manually. The orchestrator already knows each adapter's endpoint URL from the route table and propagates route metadata to peers via iBGP.

### What exists today

- **Status page** (`apps/web-ui`): Services tab with health checks for orchestrator/gateway/auth/envoy. Adapters tab lists local routes with name, protocol, endpoint — no health status.
- **Adapter health endpoints**: `CatalystProducerServer` (SDK) exposes `GET /health` returning `{ status: "Health", timestamp }`. Some consumers add their own.
- **Route propagation**: Local routes propagate to peers via iBGP with metadata (name, protocol, endpoint, peer, nodePath, originNode).
- **`/api/state`**: Returns `{ routes: { local, internal }, peers }` — consumed by the web-ui frontend.

### Why the origin node checks health

Adapters register with their local node's orchestrator. The adapter endpoint (e.g. `http://books:4001/graphql`) is network-reachable from the node where it was registered, but may not be reachable from peer nodes or the web-ui. The origin node is the only component guaranteed to reach its local adapters.

## Design

### Backend: AdapterHealthChecker

A new component in the v2 orchestrator (`apps/orchestrator/src/v2/`) that periodically probes local adapters. Health checks run in parallel via `Promise.allSettled` to avoid a single slow adapter blocking the cycle.

**Behavior:**

- Runs on a configurable interval (default 30s)
- Configurable timeout per check (default 3s)
- Can be disabled by setting `intervalMs: 0` or `enabled: false`
- Iterates over `routeTable.local.routes`
- For each route with an HTTP-based endpoint, sends `GET {baseUrl}/health` (strips path from endpoint URL, sets pathname to `/health` — same pattern as `healthUrlFromWsEndpoint()` in `dashboard.ts`)
- Records result as health metadata on the route
- When a local route is removed from the route table, its health entry is cleared

**Health status logic:**

- `GET /health` returns 2xx → `up`, record `responseTimeMs`
- `GET /health` returns 404 → `unknown` (no health endpoint). Tracks `hasHealthEndpoint: false` internally so this adapter is not re-checked on future cycles.
- `GET /health` was previously `up` and now fails (timeout, connection refused, non-2xx) → `down`
- Non-HTTP protocols (tcp, udp) → `unknown`

**Health metadata shape:**

```typescript
type AdapterHealth = {
  healthStatus: 'up' | 'down' | 'unknown'
  responseTimeMs: number | null
  lastChecked: string // ISO timestamp, from origin node's clock
}
```

### Route propagation

Health metadata is added as optional fields on `DataChannelDefinition`. When local routes are advertised to peers via iBGP, health data travels with the existing route metadata.

**Code locations that must be updated for health data to propagate:**

1. **`DataChannelDefinitionSchema`** (`packages/routing/src/v2/datachannel.ts`) — add optional `healthStatus`, `responseTimeMs`, `lastChecked` fields to the Zod schema
2. **`InternalRouteView.toDataChannel()`** (`packages/routing/src/v2/views.ts`) — include the new health fields in the returned object (currently does field-by-field extraction, not object spread)
3. **`UpdateMessageSchema`** (`packages/routing/src/v2/internal/actions.ts`) — validates routes against `DataChannelDefinitionSchema`, so adding fields to the schema is sufficient here

When a peer receives a route update with health fields, it stores them as part of the internal route. If health fields are absent (e.g. from an older node that doesn't support health checks), the status is treated as `unknown`.

### API changes

`/api/state` response shape gains optional health fields on each route:

```typescript
// Before
{ name: string, protocol: string, endpoint?: string, ... }

// After
{ name: string, protocol: string, endpoint?: string, ...,
  healthStatus?: 'up' | 'down' | 'unknown',
  responseTimeMs?: number | null,
  lastChecked?: string }
```

No new endpoints. The web-ui already polls `/api/state` every 10s.

The `originNode` field is already present on internal routes via `InternalRouteView.toPublic()`. The frontend `InternalRoute` interface in `useRouterState.ts` must be updated to include `originNode` for the Origin column.

### Frontend: Enhanced Adapters Tab

The existing Adapters tab in `apps/web-ui/frontend` is updated from a simple list to a table layout (following the Figma data channels design structure), using the existing light theme, CSS variables, and Inter/DM Mono fonts from `styles.css`.

**Columns:**

- **Data channel** — adapter/route name
- **Protocol** — http:graphql, tcp, udp, etc.
- **Endpoint** — the service URL
- **Origin** — which node the adapter is local to (local routes show "local", internal routes show the origin node name)
- **Status** — badge using existing CSS variables: `--status-up` / `--status-up-bg` for "Up", `--status-down` / `--status-down-bg` for "Down", `--status-unknown` for "Unknown"
- **Response** — health check response time in ms, or "—" if unavailable

**Footer:** Total adapter count across all nodes. "Last checked" shows the oldest `lastChecked` across all displayed adapters (most conservative — if any adapter's health data is stale, this reflects it).

**No search/filter/pagination in v1.** Can be added later if the adapter count warrants it.

### Configuration

New config fields under `config.orchestrator.adapterHealth`:

| Field        | Env Var                               | Default | Description                            |
| ------------ | ------------------------------------- | ------- | -------------------------------------- |
| `enabled`    | `CATALYST_ADAPTER_HEALTH_ENABLED`     | `true`  | Enable/disable adapter health checking |
| `intervalMs` | `CATALYST_ADAPTER_HEALTH_INTERVAL_MS` | `30000` | How often to check adapter health      |
| `timeoutMs`  | `CATALYST_ADAPTER_HEALTH_TIMEOUT_MS`  | `3000`  | Timeout per individual health check    |

## Testing

### Unit tests (AdapterHealthChecker)

- Adapter with `/health` returning 200 → status `up`, responseTimeMs recorded
- Adapter with `/health` returning 404 → status `unknown`, not re-checked on future cycles
- Adapter previously `up` then `/health` times out → status `down`
- Adapter previously `up` then `/health` returns 500 → status `down`
- Non-HTTP protocol adapter → status `unknown`, no HTTP request made
- Health check URL construction: `http://books:4001/graphql` → `http://books:4001/health`
- Route removed → health entry cleared
- Checks run in parallel (mock multiple adapters with different latencies)
- `enabled: false` → no checks run
- `intervalMs: 0` → no checks run

### Integration tests (propagation)

- Local route with health data appears in `/api/state` response
- Health data propagates to peer node via iBGP (two-node topology test)
- Peer receives route from older node without health fields → treated as `unknown`
- Health status updates propagate when adapter goes down

### Frontend tests

- Adapters tab renders table with all columns
- Up/Down/Unknown badges render with correct styles
- Missing health data renders as "Unknown"
- Footer shows correct adapter count and oldest lastChecked

### Manual testing

1. **Start a local dev cluster** with orchestrator + web-ui + a simple HTTP adapter that has `/health`
2. **Verify "Up"**: Open status page, check adapter shows green "Up" with response time
3. **Verify "Down"**: Stop the adapter process, wait for next health check cycle (30s), confirm status changes to red "Down"
4. **Verify "Unknown"**: Register a TCP adapter (no `/health` endpoint), confirm it shows yellow "Unknown"
5. **Verify propagation**: Start a second node peered with the first, confirm the adapter's health status appears on the second node's status page with the correct origin
6. **Verify recovery**: Restart the stopped adapter, confirm status returns to "Up" on both nodes

## Not in scope (v1)

- Canary integration / deep health checks / data freshness
- Click-through detail page per adapter
- Search, filter, pagination in the UI
- Non-HTTP health check protocols (TCP connect check, etc.)

## Known limitations

- **Clock skew**: `lastChecked` timestamps come from the origin node's clock. Peer nodes display these timestamps as-is. For v1 this is acceptable.
- **Polling cadence mismatch**: Web-ui polls every 10s but health checks run every 30s, so the UI will frequently re-fetch identical health data. Acceptable for v1.
- **v2 orchestrator only**: This targets `apps/orchestrator/src/v2/`. The v1 orchestrator is not modified.

## References

- Figma design: `https://www.figma.com/proto/2d7KnSbZY1QplKLS95dEuN/Catalyst-Designs-V1.0?node-id=6515-959` (Data Channels table layout)
- Canary strategy: `mochicake-canary-services-monorepo/documentation/plans/2026-02-18-canary-strategy.md`
- Existing status page: `apps/web-ui/`
- SDK health endpoint: `CatalystProducerServer` in `catalyst-sdk`
