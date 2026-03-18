# Health Status iBGP Propagation Design

**Status:** Proposed

**Date:** 2026-03-16

**Author:** Ian Hammerstrom

## Goal

Propagate adapter health status changes from the origin node to peer nodes via the existing iBGP route advertisement mechanism, so that every node in the mesh has visibility into the health of every adapter — not just its own local ones.

## Context

The per-adapter health checker (PRs #583-585) currently applies health data at query time — the `AdapterHealthChecker` stores results in a `healthMap` and patches them onto the `/api/state` response. This means health data is local-only: each node sees health for its own adapters, but remote adapters (learned from peers) show no health information.

The schema and propagation plumbing already exist:

- `DataChannelDefinitionSchema` has optional `healthStatus`, `responseTimeMs`, `lastChecked` fields
- `InternalRouteView.toDataChannel()` includes these fields
- iBGP update messages use `DataChannelDefinitionSchema` for route data

What's missing: nothing writes health data into the RIB state, so it never enters the propagation pipeline.

## Design

### New action: `LocalRouteHealthUpdate`

A new RIB action following the `LocalPeerUpdate` pattern. When dispatched, it updates the health fields on an existing local route without removing/re-adding it.

**Action type:** `local:route:health-update`

**Data schema:**

```typescript
{
  name: string // route to update (lookup key)
  healthStatus: 'up' | 'down' | 'unknown'
  responseTimeMs: number | null
  lastChecked: string // ISO timestamp
}
```

**RIB planner behavior:**

- Find local route by `name`
- If not found → `noChange()` (no-op)
- If health fields are identical to current values → `noChange()` (no churn)
- Otherwise → return new state with updated route, `routeChanges: [{ type: 'updated', route }]`

The `type: 'updated'` route change triggers the existing `handleBGPNotify` post-commit flow, which propagates the updated route to all connected peers via `buildUpdatesForPeer()` → `BusTransforms.toDataChannel()`.

### Dispatch only on status change

The health checker dispatches `LocalRouteHealthUpdate` only when `healthStatus` actually changes (up→down, down→up, unknown→up). This prevents iBGP churn from `lastChecked` timestamp updates every 30s.

```
Health checker cycle:
  For each local adapter:
    1. Check GET /health
    2. Determine new healthStatus
    3. If healthStatus CHANGED from previous:
       → dispatch LocalRouteHealthUpdate into bus
       → RIB updates route → post-commit → iBGP propagates
    4. If healthStatus SAME:
       → update healthMap only (for query-time patching of lastChecked/responseTimeMs)
```

The `lastChecked` and `responseTimeMs` fields still update locally every cycle (via the existing `applyHealth` query-time patching on `/api/state`). Only status transitions trigger iBGP propagation.

### Changes to AdapterHealthChecker

The checker gains a `dispatchFn` option — a callback to dispatch actions into the bus:

```typescript
interface AdapterHealthCheckerOptions {
  intervalMs: number
  timeoutMs: number
  dispatchFn?: (action: Action) => Promise<void>
}
```

When `dispatchFn` is provided and a health status transition occurs, the checker calls:

```typescript
await this.options.dispatchFn({
  action: Actions.LocalRouteHealthUpdate,
  data: { name, healthStatus, responseTimeMs, lastChecked },
})
```

If `dispatchFn` is not provided (backward compat / tests), behavior is unchanged — query-time patching only.

### Files changed

| File                                           | Change                                             |
| ---------------------------------------------- | -------------------------------------------------- |
| `packages/routing/src/v2/action-types.ts`      | Add `LocalRouteHealthUpdate` action constant       |
| `packages/routing/src/v2/local/actions.ts`     | Add `localRouteHealthUpdateSchema`                 |
| `packages/routing/src/v2/schema.ts`            | Add to `ActionSchema` discriminated union          |
| `packages/routing/src/v2/rib/rib.ts`           | Add `planLocalRouteHealthUpdate()` handler         |
| `apps/orchestrator/src/v2/adapter-health.ts`   | Add `dispatchFn` option, dispatch on status change |
| `apps/orchestrator/src/v2/catalyst-service.ts` | Pass `dispatchFn` when creating health checker     |

### What peers receive

When node-a's books-api transitions from `up` to `down`, node-b receives an iBGP update message:

```json
{
  "updates": [
    {
      "action": "add",
      "route": {
        "name": "books-api",
        "protocol": "http:graphql",
        "endpoint": "http://books-service:8080/graphql",
        "healthStatus": "down",
        "responseTimeMs": null,
        "lastChecked": "2026-03-17T02:20:31.678Z"
      },
      "nodePath": ["node-a.dev.catalyst.local"],
      "originNode": "node-a.dev.catalyst.local"
    }
  ]
}
```

Node-b stores this as an internal route with `healthStatus: "down"`. Node-b's web-ui shows books-api with origin "node-a.dev.catalyst.local" and a red "Down" badge.

## Testing

### Unit tests (routing package)

- `LocalRouteHealthUpdate` on existing route → state updated, routeChanges has `type: 'updated'`
- `LocalRouteHealthUpdate` on non-existent route → noChange
- `LocalRouteHealthUpdate` with identical health fields → noChange (no churn)
- Health fields survive `toDataChannel()` transform
- Journal replays `LocalRouteHealthUpdate` correctly

### Unit tests (health checker)

- Status change (up→down) dispatches `LocalRouteHealthUpdate`
- Same status repeated does NOT dispatch
- `dispatchFn` not provided → no dispatch, no error

### Integration tests (orchestrator)

- Health update propagates to connected peer via iBGP
- Peer's `/api/state` shows updated health status for internal route

### Manual testing

1. Start two-node cluster with auth (use `docker-compose/init-two-node.sh`)
2. Register adapters on both nodes, set up peering
3. Verify both nodes show each other's adapters with health status
4. Stop an adapter → verify status changes to "Down" on both nodes
5. Restart adapter → verify recovery on both nodes
