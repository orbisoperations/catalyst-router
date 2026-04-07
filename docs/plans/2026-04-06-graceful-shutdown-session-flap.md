# Graceful Shutdown & Session Flap Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add graceful shutdown drain signal and peer session flap detection to the BGP-like routing protocol.

**Architecture:** Graceful shutdown adds a `draining` flag to local routes and deprioritizes drained routes in best-path selection. Session flap detection tracks consecutive peer failures and defers initial sync with exponential backoff. Both features are independent and touch the RIB plan/commit pipeline.

**Tech Stack:** TypeScript, Zod, Vitest, existing OrchestratorBus + MockPeerTransport + TopologyHelper patterns.

**Spec:** `docs/specs/2026-04-06-bgp-graceful-shutdown-session-flap.md`

**Branch:** Stack on `ih/bgp-flap-damping`. Create `ih/bgp-graceful-shutdown` for feature 1, then `ih/bgp-session-flap` stacked on top for feature 2.

---

### Task 1: Add `draining` field and new action types

**Files:**

- Modify: `packages/routing/src/v2/datachannel.ts:15-31`
- Modify: `packages/routing/src/v2/action-types.ts:1-28`
- Modify: `packages/routing/src/v2/system/actions.ts`
- Modify: `packages/routing/src/v2/schema.ts`

- [ ] **Step 1: Add `draining` to `DataChannelDefinitionSchema`**

In `packages/routing/src/v2/datachannel.ts`, add to the schema object:

```typescript
draining: z.boolean().optional(),
```

Add it after the `lastChecked` field (line 29).

- [ ] **Step 2: Add action type constants**

In `packages/routing/src/v2/action-types.ts`, add to the `Actions` object in the `// System` section:

```typescript
AdminGracefulShutdown: 'admin:graceful-shutdown',
AdminCancelShutdown: 'admin:cancel-shutdown',
```

- [ ] **Step 3: Add action message schemas**

In `packages/routing/src/v2/system/actions.ts`, add after the existing `TickMessageSchema`:

```typescript
export const AdminGracefulShutdownMessageSchema = z.object({
  action: z.literal(Actions.AdminGracefulShutdown),
  data: z.object({}),
})

export const AdminCancelShutdownMessageSchema = z.object({
  action: z.literal(Actions.AdminCancelShutdown),
  data: z.object({}),
})
```

- [ ] **Step 4: Register in ActionSchema discriminated union**

In `packages/routing/src/v2/schema.ts`, import the new schemas:

```typescript
import {
  TickMessageSchema,
  AdminGracefulShutdownMessageSchema,
  AdminCancelShutdownMessageSchema,
} from './system/actions.js'
```

Add them to the `z.discriminatedUnion` array:

```typescript
AdminGracefulShutdownMessageSchema,
AdminCancelShutdownMessageSchema,
```

- [ ] **Step 5: Verify existing tests still pass**

Run: `pnpm run test:unit`
Expected: All existing tests pass.

- [ ] **Step 6: Commit**

```bash
gt checkout ih/bgp-flap-damping --no-interactive
gt branch create --no-interactive ih/bgp-graceful-shutdown
git add packages/routing/src/v2/datachannel.ts packages/routing/src/v2/action-types.ts packages/routing/src/v2/system/actions.ts packages/routing/src/v2/schema.ts
gt commit create --no-interactive -m "feat(routing): add draining field and admin shutdown action types"
```

---

### Task 2: Implement graceful shutdown in RIB + unit tests

**Files:**

- Modify: `packages/routing/src/v2/rib/rib.ts`
- Create: `apps/orchestrator/tests/v2/graceful-shutdown.test.ts`

- [ ] **Step 1: Add plan handlers to RIB**

In `packages/routing/src/v2/rib/rib.ts`, add the derived action data types at the top (near the other type aliases):

```typescript
type AdminGracefulShutdownData = Extract<
  Action,
  { action: typeof Actions.AdminGracefulShutdown }
>['data']
type AdminCancelShutdownData = Extract<
  Action,
  { action: typeof Actions.AdminCancelShutdown }
>['data']
```

Add cases to the `plan()` switch statement:

```typescript
case Actions.AdminGracefulShutdown:
  return this.planAdminGracefulShutdown(action.data, state)
case Actions.AdminCancelShutdown:
  return this.planAdminCancelShutdown(action.data, state)
```

Add the handler methods:

```typescript
private planAdminGracefulShutdown(_data: AdminGracefulShutdownData, state: RouteTable): PlanResult {
  if (state.local.routes.length === 0) return noChange(state)

  const routes = state.local.routes.map((r) => ({ ...r, draining: true }))
  const routeChanges: RouteChange[] = routes.map((r) => ({ type: 'updated' as const, route: r }))

  const newState: RouteTable = {
    ...state,
    local: { ...state.local, routes },
  }
  return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges }
}

private planAdminCancelShutdown(_data: AdminCancelShutdownData, state: RouteTable): PlanResult {
  const drainingRoutes = state.local.routes.filter((r) => r.draining === true)
  if (drainingRoutes.length === 0) return noChange(state)

  const routes = state.local.routes.map((r) => {
    const { draining, ...rest } = r
    return rest
  })
  const routeChanges: RouteChange[] = routes.map((r) => ({ type: 'updated' as const, route: r }))

  const newState: RouteTable = {
    ...state,
    local: { ...state.local, routes },
  }
  return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges }
}
```

- [ ] **Step 2: Add drain deprioritization in best-path selection**

In `planInternalProtocolUpdate`, inside the `if (existingIdx !== -1)` block where best-path is evaluated, add a drain check. The current logic is:

```typescript
const betterPath = item.nodePath.length < existing.nodePath.length
const replacingStale = existing.isStale === true
if (betterPath || replacingStale) {
```

Change to:

```typescript
const betterPath = item.nodePath.length < existing.nodePath.length
const replacingStale = existing.isStale === true
const existingDrained = 'draining' in existing && existing.draining === true
const newDrained = 'draining' in newRoute && newRoute.draining === true
const drainingAdvantage = existingDrained && !newDrained
if (betterPath || replacingStale || drainingAdvantage) {
```

Also handle the reverse: don't replace a non-drained route with a drained one even if shorter path:

```typescript
const drainingDisadvantage = !existingDrained && newDrained
if (drainingDisadvantage) {
  // Don't replace a healthy route with a draining one
} else if (betterPath || replacingStale || drainingAdvantage) {
```

- [ ] **Step 3: Write tests**

Create `apps/orchestrator/tests/v2/graceful-shutdown.test.ts` with imports following the pattern from `max-prefix.test.ts`. Import `Action` type for proper typing.

Tests:

```typescript
describe('Graceful shutdown', () => {
  it('marks all local routes as draining', () => {
    // Create RIB, add 2 local routes, dispatch AdminGracefulShutdown
    // Verify both routes in newState have draining: true
    // Verify routeChanges has 2 'updated' entries
  })

  it('propagates drained routes to peers', () => {
    // Create OrchestratorBus with MockPeerTransport, add peer, add local route
    // Dispatch AdminGracefulShutdown
    // Check transport.getCallsFor('sendUpdate') contains the route with draining: true
  })

  it('peers deprioritize drained routes — non-drained wins even if longer path', () => {
    // Create RIB with a connected peer
    // Add an internal route from peer-B with nodePath=['b'] (length 1)
    // Then receive same route from peer-C with nodePath=['c','d'] (length 2) but draining:true on existing
    // Actually: set up so existing route has draining flag, new one doesn't
    // Verify the non-drained route replaces the drained one
  })

  it('cancel removes drain marker', () => {
    // Create RIB, add local routes, shutdown, then cancel
    // Verify routes no longer have draining field
    // Verify routeChanges for cancel has 'updated' entries
  })
})
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/orchestrator/tests/v2/graceful-shutdown.test.ts`
Then: `pnpm run test:unit`

- [ ] **Step 5: Commit**

```bash
gt commit create --no-interactive -m "feat(routing): implement graceful shutdown with drain signal"
```

---

### Task 3: Topology test for graceful shutdown

**Files:**

- Modify: `apps/orchestrator/tests/v2/graceful-shutdown.test.ts`

- [ ] **Step 1: Add topology test**

Copy TopologyHelper into the test file (following the pattern from max-prefix.test.ts). Add:

```typescript
describe('Graceful shutdown topology', () => {
  it('A drains → C switches to B; A cancels → C switches back', async () => {
    // Setup: A↔C, B↔C (triangle, both advertising same route)
    // A and B both create a local route 'shared-svc'
    // Propagate A→C, B→C. C has route from both, prefers A (shorter or equal path)
    //
    // A dispatches AdminGracefulShutdown
    // Propagate A→C (drained route update)
    // Verify C now prefers B's non-drained route
    //
    // A dispatches AdminCancelShutdown
    // Propagate A→C (undrained route update)
    // Verify C prefers A again (or equal, both non-drained)
  })
})
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run apps/orchestrator/tests/v2/graceful-shutdown.test.ts`
Then: `pnpm run test:unit`

- [ ] **Step 3: Commit**

```bash
gt commit create --no-interactive -m "test(routing): add topology test for graceful shutdown drain"
```

---

### Task 4: Add session flap detection types

**Files:**

- Modify: `packages/routing/src/v2/state.ts`

- [ ] **Step 1: Add fields to PeerRecordSchema**

In `packages/routing/src/v2/state.ts`, add to `PeerRecordSchema`:

```typescript
consecutiveFailures: z.number().int().min(0).default(0),
lastFailure: z.number().default(0),
syncDeferredUntil: z.number().default(0),
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `pnpm run test:unit`
Expected: All tests pass (additive, defaults maintain backward compat).

- [ ] **Step 3: Create new stacked branch and commit**

```bash
gt branch create --no-interactive ih/bgp-session-flap
git add packages/routing/src/v2/state.ts
gt commit create --no-interactive -m "feat(routing): add session flap detection fields to PeerRecord"
```

---

### Task 5: Implement session flap detection + tests

**Files:**

- Modify: `packages/routing/src/v2/rib/rib.ts`
- Modify: `apps/orchestrator/src/v2/bus.ts`
- Create: `apps/orchestrator/tests/v2/session-flap.test.ts`

- [ ] **Step 1: Add constants to RIB**

In `packages/routing/src/v2/rib/rib.ts`, add after the flap damping constants:

```typescript
// ---------------------------------------------------------------------------
// Session flap detection constants (RFC 4271 §8 / BIRD error-wait model)
// ---------------------------------------------------------------------------
export const SESSION_FLAP_BASE_DELAY_MS = 5_000 // 5 seconds
export const SESSION_FLAP_MAX_DELAY_MS = 300_000 // 5 minutes cap
export const SESSION_FLAP_STABILITY_MS = 300_000 // 5 minutes stable = reset
```

- [ ] **Step 2: Track failures in `planInternalProtocolClose`**

In the existing `planInternalProtocolClose` method, after the peer's `connectionStatus` is set to `'closed'`, also increment `consecutiveFailures` and set `lastFailure`:

In the `peers` mapping at the end of the method (where it sets `connectionStatus: 'closed'`), change:

```typescript
const peers = state.internal.peers.map((p, i) =>
  i === idx ? { ...p, connectionStatus: 'closed' as const } : p
)
```

to:

```typescript
const peers = state.internal.peers.map((p, i) =>
  i === idx
    ? {
        ...p,
        connectionStatus: 'closed' as const,
        consecutiveFailures: (p.consecutiveFailures ?? 0) + 1,
        lastFailure: Date.now(),
      }
    : p
)
```

- [ ] **Step 3: Calculate sync defer on `planInternalProtocolConnected`**

In `planInternalProtocolConnected`, after the existing peer update logic, add sync defer calculation. The current method builds an `updated` PeerRecord. Add the defer calculation:

```typescript
const failures = existing.consecutiveFailures ?? 0
const syncDelay =
  failures > 0
    ? Math.min(SESSION_FLAP_BASE_DELAY_MS * Math.pow(2, failures - 1), SESSION_FLAP_MAX_DELAY_MS)
    : 0
const syncDeferredUntil = syncDelay > 0 ? Date.now() + syncDelay : 0
```

Include `syncDeferredUntil` in the updated peer record.

- [ ] **Step 4: Add stability reset to `planTick`**

In `planTick`, after the existing flap damping decay block and before the hold-timer expiry logic, add:

```typescript
// --- Session flap stability reset ---
let sessionFlapChanged = false
const peersAfterStabilityReset = peers.map((p) => {
  if (
    (p.consecutiveFailures ?? 0) > 0 &&
    p.connectionStatus === 'connected' &&
    p.lastReceived > 0 &&
    data.now - p.lastReceived > SESSION_FLAP_STABILITY_MS
  ) {
    sessionFlapChanged = true
    return { ...p, consecutiveFailures: 0, lastFailure: 0, syncDeferredUntil: 0 }
  }
  return p
})
```

Use `peersAfterStabilityReset` instead of `peers` for the rest of the method. Update the no-change check to also consider `sessionFlapChanged`.

- [ ] **Step 5: Add deferred sync check in bus.ts**

In `apps/orchestrator/src/v2/bus.ts`, in the `handlePostCommit` method, find the initial sync block:

```typescript
if (action.action === Actions.InternalProtocolConnected) {
  const peerName = action.data.peerInfo.name
  const peer = connectedPeers.find((p) => p.name === peerName)
  if (peer !== undefined) {
```

Add a defer check after finding the peer:

```typescript
if (peer !== undefined) {
  // Session flap detection: defer sync if peer has been flapping
  if (peer.syncDeferredUntil && peer.syncDeferredUntil > Date.now()) {
    logger.warn('Deferring initial sync to flapping peer {peerName} until {deferUntil}', {
      'event.name': 'peer.sync.deferred',
      peerName,
      deferUntil: new Date(peer.syncDeferredUntil).toISOString(),
      consecutiveFailures: peer.consecutiveFailures,
    })
  } else {
    await withWideEvent('orchestrator.peer_sync', logger, async (event) => {
      // ... existing sync logic
    })
  }
}
```

- [ ] **Step 6: Write tests**

Create `apps/orchestrator/tests/v2/session-flap.test.ts`:

```typescript
describe('Peer session flap detection', () => {
  it('first disconnect sets consecutiveFailures to 1', () => {
    // Create RIB, add peer, connect, then close
    // Verify peer.consecutiveFailures === 1
  })

  it('third consecutive reconnect has syncDeferredUntil set (20s delay)', () => {
    // Close/connect 3 times
    // On 3rd connect: delay = 5000 * 2^2 = 20000
    // Verify peer.syncDeferredUntil is ~now + 20000
  })

  it('delay capped at MAX_DELAY after many failures', () => {
    // Close/connect 20 times
    // Verify syncDeferredUntil - now <= SESSION_FLAP_MAX_DELAY_MS
  })

  it('stable for 5 minutes via Tick resets consecutiveFailures', () => {
    // Close, reconnect (failures=1)
    // Dispatch Tick with now + SESSION_FLAP_STABILITY_MS + 1000
    // Verify consecutiveFailures reset to 0
  })

  it('non-flapping peer gets immediate sync (syncDeferredUntil = 0)', () => {
    // Create peer, connect for first time (no prior failures)
    // Verify syncDeferredUntil === 0
  })
})
```

- [ ] **Step 7: Run tests**

Run: `pnpm vitest run apps/orchestrator/tests/v2/session-flap.test.ts`
Then: `pnpm run test:unit`
Then: `pnpm exec turbo run typecheck`

- [ ] **Step 8: Commit**

```bash
gt commit create --no-interactive -m "feat(routing): implement peer session flap detection with exponential backoff"
```

---

### Task 6: Submit stacked PRs

- [ ] **Step 1: Final verification**

Run: `pnpm run test:unit`
Run: `pnpm exec turbo run typecheck`

- [ ] **Step 2: Submit**

```bash
gt submit --no-interactive
```

- [ ] **Step 3: Update PR descriptions and comment on issues**

Update PR descriptions via `gh api` with issue context, implementation details, and "How it was tested" sections (following the pattern from PRs #651/#652).

Comment on issues:

```bash
gh issue comment 404 --repo orbisoperations/catalyst-router --body "PR: <graceful-shutdown-pr-url>"
gh issue comment 408 --repo orbisoperations/catalyst-router --body "PR: <session-flap-pr-url>"
```
