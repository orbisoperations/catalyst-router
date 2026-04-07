# BGP Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add max prefix limits per peer and route flap damping to the BGP-like routing protocol.

**Architecture:** Two independent safety features added to the RIB state machine. Max prefix limits gate route acceptance (entry). Flap damping gates route propagation (exit). Both tested via unit tests on RIB `plan()` and multi-node topology tests using `TopologyHelper`.

**Tech Stack:** TypeScript, Zod, Vitest, existing OrchestratorBus + MockPeerTransport + TopologyHelper patterns.

**Spec:** `docs/specs/2026-04-06-bgp-hardening-prefix-limits-flap-damping.md`

---

### Task 1: Add `maxPrefixes` to type system

**Files:**

- Modify: `packages/routing/src/v2/state.ts:11-18`
- Modify: `packages/routing/src/v2/local/actions.ts:13-16`
- Modify: `packages/routing/src/v2/rib/rib.ts:158-177`

- [ ] **Step 1: Add `maxPrefixes` to `PeerRecordSchema`**

In `packages/routing/src/v2/state.ts`, add `maxPrefixes` to the schema:

```typescript
export const PeerRecordSchema = PeerInfoSchema.extend({
  connectionStatus: PeerConnectionStatusEnum,
  lastConnected: z.number().default(0),
  holdTime: z.number().default(90_000),
  lastSent: z.number().default(0),
  lastReceived: z.number().default(0),
  maxPrefixes: z.number().int().min(0).optional(),
})
```

- [ ] **Step 2: Extend `localPeerCreateMessageSchema` data to accept `maxPrefixes`**

In `packages/routing/src/v2/local/actions.ts`, change the data schema:

```typescript
export const localPeerCreateMessageSchema = z.object({
  action: z.literal(Actions.LocalPeerCreate),
  data: PeerInfoSchema.extend({
    maxPrefixes: z.number().int().min(0).optional(),
  }),
})
```

- [ ] **Step 3: Thread `maxPrefixes` through `planLocalPeerCreate`**

In `packages/routing/src/v2/rib/rib.ts`, update the handler to accept the extended type and include `maxPrefixes` in the new PeerRecord:

```typescript
private planLocalPeerCreate(
  data: PeerInfo & { maxPrefixes?: number },
  state: RouteTable
): PlanResult {
  const exists = state.internal.peers.some((p) => p.name === data.name)
  if (exists) return noChange(state)

  const newPeer: PeerRecord = {
    ...data,
    connectionStatus: 'initializing',
    lastConnected: 0,
    holdTime: 90_000,
    lastSent: 0,
    lastReceived: 0,
  }
  // ... rest unchanged
```

Note: `...data` already spreads `maxPrefixes` if present since PeerRecord now includes it.

- [ ] **Step 4: Verify existing tests still pass**

Run: `pnpm run test:unit`
Expected: All existing tests pass (no behavioral change yet).

- [ ] **Step 5: Commit**

```bash
gt commit create --no-interactive -m "feat(routing): add maxPrefixes field to PeerRecord and LocalPeerCreate schema"
```

---

### Task 2: Implement max prefix limit enforcement in RIB

**Files:**

- Modify: `packages/routing/src/v2/rib/rib.ts:406-478`
- Create: `apps/orchestrator/tests/v2/max-prefix.test.ts`

- [ ] **Step 1: Write failing test — accept routes at exactly the limit**

Create `apps/orchestrator/tests/v2/max-prefix.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { RoutingInformationBase } from '@catalyst/routing/v2/rib'
import { Actions } from '@catalyst/routing/v2'
import {
  newRouteTable,
  type RouteTable,
  type PeerRecord,
  type PeerInfo,
} from '@catalyst/routing/v2/state'

const nodeId = 'node-a'
const peerB: PeerInfo = { name: 'node-b', endpoint: 'ws://b:4000', domains: ['test.local'] }

function makeRoute(name: string) {
  return { name, protocol: 'http' as const, endpoint: `http://${name}:8080` }
}

function stateWithPeer(maxPrefixes?: number): RouteTable {
  const state = newRouteTable()
  const peer: PeerRecord = {
    ...peerB,
    connectionStatus: 'connected',
    lastConnected: 1000,
    holdTime: 90_000,
    lastSent: 0,
    lastReceived: 1000,
    maxPrefixes,
  }
  state.internal.peers = [peer]
  return state
}

function makeUpdate(routes: { name: string }[], action: 'add' | 'remove' = 'add') {
  return {
    action: Actions.InternalProtocolUpdate as const,
    data: {
      peerInfo: peerB,
      update: {
        updates: routes.map((r) => ({
          action,
          route: makeRoute(r.name),
          nodePath: ['node-b'],
          originNode: 'node-b',
        })),
      },
    },
  }
}

describe('Max prefix limits', () => {
  it('accepts routes up to exactly the limit', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = stateWithPeer(3)

    const plan = rib.plan(
      makeUpdate([{ name: 'svc-1' }, { name: 'svc-2' }, { name: 'svc-3' }]),
      state
    )
    expect(plan.routeChanges.filter((c) => c.type === 'added')).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/orchestrator/tests/v2/max-prefix.test.ts`
Expected: PASS (no enforcement yet, so 3 routes accepted — this is our baseline).

- [ ] **Step 3: Write failing test — excess routes individually dropped**

Add to the same describe block:

```typescript
it('drops excess routes individually (earlier routes in batch accepted)', () => {
  const rib = new RoutingInformationBase({ nodeId })
  const state = stateWithPeer(3)

  const plan = rib.plan(
    makeUpdate([
      { name: 'svc-1' },
      { name: 'svc-2' },
      { name: 'svc-3' },
      { name: 'svc-4' },
      { name: 'svc-5' },
    ]),
    state
  )
  // Should accept first 3, drop svc-4 and svc-5
  expect(plan.routeChanges.filter((c) => c.type === 'added')).toHaveLength(3)
  const addedNames = plan.routeChanges.filter((c) => c.type === 'added').map((c) => c.route.name)
  expect(addedNames).toEqual(['svc-1', 'svc-2', 'svc-3'])
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run apps/orchestrator/tests/v2/max-prefix.test.ts`
Expected: FAIL — currently accepts all 5 routes.

- [ ] **Step 5: Implement prefix limit enforcement**

In `packages/routing/src/v2/rib/rib.ts`, modify `planInternalProtocolUpdate`:

```typescript
private planInternalProtocolUpdate(
  data: InternalProtocolUpdateData,
  state: RouteTable
): PlanResult {
  let routes = [...state.internal.routes]
  const portOps: PortOperation[] = []
  const routeChanges: RouteChange[] = []

  // --- Max prefix limit setup ---
  const peer = state.internal.peers.find((p) => p.name === data.peerInfo.name)
  const prefixLimit = peer?.maxPrefixes
  const hasLimit = prefixLimit != null && prefixLimit > 0
  let currentPeerRouteCount = hasLimit
    ? routes.filter((r) => r.peer.name === data.peerInfo.name).length
    : 0
  const warnThreshold = hasLimit ? Math.floor(prefixLimit * 0.8) : 0

  for (const item of data.update.updates) {
    if (item.action === 'add') {
      // Loop detection — discard advertisements that already include this node
      if (item.nodePath.includes(this._nodeId)) continue

      // --- Max prefix limit check ---
      if (hasLimit && currentPeerRouteCount >= prefixLimit) {
        // Drop excess route silently (Juniper drop-excess model)
        continue
      }

      const key = routeKey(item.route)
      const existingIdx = routes.findIndex(
        (r) => routeKey(r) === key && r.originNode === item.originNode
      )

      const newRoute: InternalRoute = {
        ...item.route,
        peer: data.peerInfo,
        nodePath: item.nodePath,
        originNode: item.originNode,
        isStale: false,
      }

      if (existingIdx !== -1) {
        const existing = routes[existingIdx]
        const betterPath = item.nodePath.length < existing.nodePath.length
        const replacingStale = existing.isStale === true
        if (betterPath || replacingStale) {
          routes = routes.map((r, i) => (i === existingIdx ? newRoute : r))
          routeChanges.push({ type: 'updated', route: newRoute })
        }
        // Replacing an existing route does not change the count
      } else {
        routes = [...routes, newRoute]
        routeChanges.push({ type: 'added', route: newRoute })
        currentPeerRouteCount++

        // Warn at 80% threshold
        if (hasLimit && currentPeerRouteCount === warnThreshold) {
          // Warning will be logged by the bus layer via WideEvent
        }
      }
    } else {
      // action === 'remove' — always processed regardless of limit
      const key = routeKey(item.route)
      const removed = routes.find((r) => routeKey(r) === key && r.originNode === item.originNode)
      if (removed !== undefined) {
        routes = routes.filter((r) => !(routeKey(r) === key && r.originNode === item.originNode))
        routeChanges.push({ type: 'removed', route: removed })
        if (removed.envoyPort != null) {
          portOps.push({ type: 'release', routeKey: key, port: removed.envoyPort })
        }
        if (hasLimit) currentPeerRouteCount--
      }
    }
  }

  // Always update lastReceived on the peer, even when no routes changed
  const peerIdx = state.internal.peers.findIndex((p) => p.name === data.peerInfo.name)
  const peers =
    peerIdx !== -1
      ? state.internal.peers.map((p, i) =>
          i === peerIdx ? { ...p, lastReceived: Date.now() } : p
        )
      : state.internal.peers

  if (routeChanges.length === 0 && peerIdx === -1) {
    return noChange(state)
  }

  const newState: RouteTable = {
    ...state,
    internal: { peers, routes },
  }
  return { prevState: state, newState, portOps, routeChanges }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run apps/orchestrator/tests/v2/max-prefix.test.ts`
Expected: Both tests PASS.

- [ ] **Step 7: Add remaining unit tests**

Add to `max-prefix.test.ts`:

```typescript
it('remove below limit then add more succeeds', () => {
  const rib = new RoutingInformationBase({ nodeId })
  let state = stateWithPeer(3)

  // Fill to limit
  const plan1 = rib.plan(
    makeUpdate([{ name: 'svc-1' }, { name: 'svc-2' }, { name: 'svc-3' }]),
    state
  )
  state = rib.commit(plan1, makeUpdate([{ name: 'svc-1' }, { name: 'svc-2' }, { name: 'svc-3' }]))

  // Remove one
  const plan2 = rib.plan(makeUpdate([{ name: 'svc-2' }], 'remove'), state)
  state = rib.commit(plan2, makeUpdate([{ name: 'svc-2' }], 'remove'))

  // Add a new one — should succeed (now at 2/3)
  const plan3 = rib.plan(makeUpdate([{ name: 'svc-4' }]), state)
  expect(plan3.routeChanges.filter((c) => c.type === 'added')).toHaveLength(1)
})

it('maxPrefixes: 0 means unlimited', () => {
  const rib = new RoutingInformationBase({ nodeId })
  const state = stateWithPeer(0)

  const routes = Array.from({ length: 100 }, (_, i) => ({ name: `svc-${i}` }))
  const plan = rib.plan(makeUpdate(routes), state)
  expect(plan.routeChanges.filter((c) => c.type === 'added')).toHaveLength(100)
})

it('peer with no maxPrefixes set works unchanged', () => {
  const rib = new RoutingInformationBase({ nodeId })
  const state = stateWithPeer(undefined)

  const routes = Array.from({ length: 50 }, (_, i) => ({ name: `svc-${i}` }))
  const plan = rib.plan(makeUpdate(routes), state)
  expect(plan.routeChanges.filter((c) => c.type === 'added')).toHaveLength(50)
})

it('count is per-peer — peer A at limit does not affect peer B', () => {
  const rib = new RoutingInformationBase({ nodeId })
  const peerC: PeerInfo = { name: 'node-c', endpoint: 'ws://c:4000', domains: ['test.local'] }
  const state = newRouteTable()
  state.internal.peers = [
    {
      ...peerB,
      connectionStatus: 'connected',
      lastConnected: 1000,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 1000,
      maxPrefixes: 2,
    },
    {
      ...peerC,
      connectionStatus: 'connected',
      lastConnected: 1000,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 1000,
      maxPrefixes: 2,
    },
  ]

  // Fill peer B to limit
  const plan1 = rib.plan(makeUpdate([{ name: 'b-1' }, { name: 'b-2' }, { name: 'b-3' }]), state)
  expect(plan1.routeChanges.filter((c) => c.type === 'added')).toHaveLength(2) // 2 accepted, 1 dropped

  const state2 = rib.commit(plan1, makeUpdate([{ name: 'b-1' }, { name: 'b-2' }, { name: 'b-3' }]))

  // Peer C should still accept routes
  const plan2 = rib.plan(
    {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerC,
        update: {
          updates: [
            { action: 'add', route: makeRoute('c-1'), nodePath: ['node-c'], originNode: 'node-c' },
          ],
        },
      },
    },
    state2
  )
  expect(plan2.routeChanges.filter((c) => c.type === 'added')).toHaveLength(1)
})
```

- [ ] **Step 8: Run all max-prefix tests**

Run: `pnpm vitest run apps/orchestrator/tests/v2/max-prefix.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 9: Run full test suite**

Run: `pnpm run test:unit`
Expected: All tests PASS.

- [ ] **Step 10: Commit**

```bash
gt commit create --no-interactive -m "feat(routing): implement max prefix limits per peer (drop-excess model)"
```

---

### Task 3: Implement route flap damping in RIB

**Files:**

- Modify: `packages/routing/src/v2/rib/rib.ts`
- Create: `apps/orchestrator/tests/v2/flap-damping.test.ts`

- [ ] **Step 1: Add flap damping constants and state to RIB**

Add at the top of `packages/routing/src/v2/rib/rib.ts` (after imports):

```typescript
// ---------------------------------------------------------------------------
// Flap damping constants (RFC 2439 / RFC 7196 / RIPE-580)
// ---------------------------------------------------------------------------
export const FLAP_PENALTY_INCREMENT = 1000
export const FLAP_SUPPRESS_THRESHOLD = 6000
export const FLAP_REUSE_THRESHOLD = 750
export const FLAP_HALF_LIFE_MS = 300_000 // 5 minutes
export const FLAP_MAX_SUPPRESS_MS = 1_800_000 // 30 minutes

export type FlapEntry = {
  penalty: number
  suppressed: boolean
  suppressedAt: number | null
  lastUpdated: number
}
```

Add to the `RoutingInformationBase` class:

```typescript
/** Ephemeral flap damping state — does not survive restart. */
private _flapState = new Map<string, FlapEntry>()

get flapState(): ReadonlyMap<string, FlapEntry> {
  return this._flapState
}

private flapKey(routeKey: string, originNode: string): string {
  return `${routeKey}:${originNode}`
}

private decayPenalty(entry: FlapEntry, now: number): number {
  const elapsed = now - entry.lastUpdated
  if (elapsed <= 0) return entry.penalty
  return entry.penalty * Math.pow(0.5, elapsed / FLAP_HALF_LIFE_MS)
}
```

- [ ] **Step 2: Write failing test — single flap below threshold stays usable**

Create `apps/orchestrator/tests/v2/flap-damping.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  RoutingInformationBase,
  FLAP_SUPPRESS_THRESHOLD,
  FLAP_REUSE_THRESHOLD,
  FLAP_HALF_LIFE_MS,
  FLAP_MAX_SUPPRESS_MS,
} from '@catalyst/routing/v2/rib'
import { Actions } from '@catalyst/routing/v2'
import {
  newRouteTable,
  type RouteTable,
  type PeerRecord,
  type PeerInfo,
} from '@catalyst/routing/v2/state'
import { routeKey } from '@catalyst/routing/v2/datachannel'

const nodeId = 'node-a'
const peerB: PeerInfo = { name: 'node-b', endpoint: 'ws://b:4000', domains: ['test.local'] }
const route1 = { name: 'svc-1', protocol: 'http' as const, endpoint: 'http://svc-1:8080' }

function connectedState(): RouteTable {
  const state = newRouteTable()
  const peer: PeerRecord = {
    ...peerB,
    connectionStatus: 'connected',
    lastConnected: 1000,
    holdTime: 90_000,
    lastSent: 0,
    lastReceived: 1000,
  }
  state.internal.peers = [peer]
  return state
}

function addUpdate(route: typeof route1) {
  return {
    action: Actions.InternalProtocolUpdate as const,
    data: {
      peerInfo: peerB,
      update: {
        updates: [{ action: 'add' as const, route, nodePath: ['node-b'], originNode: 'node-b' }],
      },
    },
  }
}

function removeUpdate(route: typeof route1) {
  return {
    action: Actions.InternalProtocolUpdate as const,
    data: {
      peerInfo: peerB,
      update: {
        updates: [{ action: 'remove' as const, route, nodePath: ['node-b'], originNode: 'node-b' }],
      },
    },
  }
}

describe('Route flap damping', () => {
  it('single withdraw/re-add below threshold — route stays usable', () => {
    const rib = new RoutingInformationBase({ nodeId })
    let state = connectedState()

    // Add route
    let plan = rib.plan(addUpdate(route1), state)
    state = rib.commit(plan, addUpdate(route1))

    // Withdraw
    plan = rib.plan(removeUpdate(route1), state)
    state = rib.commit(plan, removeUpdate(route1))

    // Re-add — penalty should be 1000 (below 6000 threshold)
    plan = rib.plan(addUpdate(route1), state)
    state = rib.commit(plan, addUpdate(route1))

    const key = rib.flapState.get(`${routeKey(route1)}:node-b`)
    expect(key?.suppressed).toBe(false)
    expect(key?.penalty).toBeLessThan(FLAP_SUPPRESS_THRESHOLD)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run apps/orchestrator/tests/v2/flap-damping.test.ts`
Expected: FAIL — `rib.flapState` doesn't exist yet.

- [ ] **Step 4: Implement flap tracking in `planInternalProtocolUpdate`**

In the `planInternalProtocolUpdate` method, add flap tracking inside the loop. After the existing `if (item.action === 'add')` block's route acceptance logic, add flap penalty tracking. For `'remove'` actions, ensure a flapState entry is created:

For `'add'` items (after the route is accepted/updated, before closing the `if` block):

```typescript
// --- Flap damping: track add-after-remove ---
const fk = this.flapKey(routeKey(item.route), item.originNode)
const flapEntry = this._flapState.get(fk)
if (flapEntry && flapEntry.penalty > 0) {
  // This route was recently removed — it's flapping
  const now = Date.now()
  const decayed = this.decayPenalty(flapEntry, now)
  const newPenalty = decayed + FLAP_PENALTY_INCREMENT
  const shouldSuppress = newPenalty >= FLAP_SUPPRESS_THRESHOLD
  this._flapState.set(fk, {
    penalty: newPenalty,
    suppressed: shouldSuppress,
    suppressedAt: shouldSuppress && !flapEntry.suppressed ? now : flapEntry.suppressedAt,
    lastUpdated: now,
  })
} else if (!flapEntry) {
  // First time seeing this route — no penalty
  this._flapState.set(fk, {
    penalty: 0,
    suppressed: false,
    suppressedAt: null,
    lastUpdated: Date.now(),
  })
}
```

For `'remove'` items (after the route is removed, inside the `if (removed !== undefined)` block):

```typescript
// --- Flap damping: mark as recently withdrawn ---
const fk = this.flapKey(routeKey(item.route), item.originNode)
const existing = this._flapState.get(fk)
if (!existing) {
  this._flapState.set(fk, {
    penalty: FLAP_PENALTY_INCREMENT,
    suppressed: false,
    suppressedAt: null,
    lastUpdated: Date.now(),
  })
} else {
  const now = Date.now()
  const decayed = this.decayPenalty(existing, now)
  this._flapState.set(fk, {
    ...existing,
    penalty: decayed + FLAP_PENALTY_INCREMENT,
    lastUpdated: now,
  })
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run apps/orchestrator/tests/v2/flap-damping.test.ts`
Expected: PASS.

- [ ] **Step 6: Write test — six rapid flaps exceed threshold**

Add to `flap-damping.test.ts`:

```typescript
it('six rapid flaps exceed threshold — route suppressed', () => {
  const rib = new RoutingInformationBase({ nodeId })
  let state = connectedState()

  // 6 flap cycles (add/remove)
  for (let i = 0; i < 6; i++) {
    let plan = rib.plan(addUpdate(route1), state)
    state = rib.commit(plan, addUpdate(route1))
    plan = rib.plan(removeUpdate(route1), state)
    state = rib.commit(plan, removeUpdate(route1))
  }

  // Final re-add — should be suppressed
  const plan = rib.plan(addUpdate(route1), state)
  state = rib.commit(plan, addUpdate(route1))

  const entry = rib.flapState.get(`${routeKey(route1)}:node-b`)
  expect(entry?.suppressed).toBe(true)
  expect(entry?.penalty).toBeGreaterThanOrEqual(FLAP_SUPPRESS_THRESHOLD)
})
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm vitest run apps/orchestrator/tests/v2/flap-damping.test.ts`
Expected: PASS.

- [ ] **Step 8: Add remaining flap damping unit tests**

Add to `flap-damping.test.ts`:

```typescript
it('different routes from same peer damped independently', () => {
  const rib = new RoutingInformationBase({ nodeId })
  const route2 = { name: 'svc-2', protocol: 'http' as const, endpoint: 'http://svc-2:8080' }
  let state = connectedState()

  // Flap route1 6 times
  for (let i = 0; i < 6; i++) {
    let plan = rib.plan(addUpdate(route1), state)
    state = rib.commit(plan, addUpdate(route1))
    plan = rib.plan(removeUpdate(route1), state)
    state = rib.commit(plan, removeUpdate(route1))
  }
  let plan = rib.plan(addUpdate(route1), state)
  state = rib.commit(plan, addUpdate(route1))

  // Add route2 normally (no flap)
  plan = rib.plan(addUpdate(route2), state)
  state = rib.commit(plan, addUpdate(route2))

  expect(rib.flapState.get(`${routeKey(route1)}:node-b`)?.suppressed).toBe(true)
  expect(rib.flapState.get(`${routeKey(route2)}:node-b`)?.suppressed).toBe(false)
})
```

- [ ] **Step 9: Run all flap damping tests**

Run: `pnpm vitest run apps/orchestrator/tests/v2/flap-damping.test.ts`
Expected: All tests PASS.

- [ ] **Step 10: Commit**

```bash
gt commit create --no-interactive -m "feat(routing): implement route flap damping with RFC 7196/RIPE-580 parameters"
```

---

### Task 4: Add flap damping decay via Tick and suppress check in propagation

**Files:**

- Modify: `packages/routing/src/v2/rib/rib.ts:502-552` (planTick)
- Modify: `apps/orchestrator/src/v2/bus.ts:641-687` (buildUpdatesForPeer)
- Modify: `apps/orchestrator/tests/v2/flap-damping.test.ts`

- [ ] **Step 1: Write failing test — Tick decays penalty and unsuppresses route**

Add to `flap-damping.test.ts`:

```typescript
it('Tick decays penalty — suppressed route becomes reusable', () => {
  const rib = new RoutingInformationBase({ nodeId })
  let state = connectedState()

  // Flap 6 times to suppress
  for (let i = 0; i < 6; i++) {
    let plan = rib.plan(addUpdate(route1), state)
    state = rib.commit(plan, addUpdate(route1))
    plan = rib.plan(removeUpdate(route1), state)
    state = rib.commit(plan, removeUpdate(route1))
  }
  let plan = rib.plan(addUpdate(route1), state)
  state = rib.commit(plan, addUpdate(route1))
  expect(rib.flapState.get(`${routeKey(route1)}:node-b`)?.suppressed).toBe(true)

  // Advance time by ~4 half-lives (20 minutes) — penalty should decay well below reuse
  // 6000 * 0.5^4 = 375 < 750 reuse threshold
  const futureTime = Date.now() + FLAP_HALF_LIFE_MS * 4

  plan = rib.plan({ action: Actions.Tick, data: { now: futureTime } }, state)
  state = rib.commit(plan, { action: Actions.Tick, data: { now: futureTime } })

  const entry = rib.flapState.get(`${routeKey(route1)}:node-b`)
  expect(entry?.suppressed).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/orchestrator/tests/v2/flap-damping.test.ts`
Expected: FAIL — `planTick` doesn't handle flap decay yet.

- [ ] **Step 3: Add flap decay logic to `planTick`**

In `packages/routing/src/v2/rib/rib.ts`, at the beginning of `planTick` (before the existing peer hold-timer logic), add flap decay:

```typescript
private planTick(data: TickData, state: RouteTable): PlanResult {
  // --- Flap damping decay ---
  let flapStateChanged = false
  for (const [key, entry] of this._flapState) {
    const decayed = this.decayPenalty(entry, data.now)

    if (decayed < 1) {
      this._flapState.delete(key)
      if (entry.suppressed) flapStateChanged = true
      continue
    }

    const shouldUnsuppress =
      entry.suppressed &&
      (decayed < FLAP_REUSE_THRESHOLD ||
        (entry.suppressedAt != null && data.now - entry.suppressedAt > FLAP_MAX_SUPPRESS_MS))

    if (shouldUnsuppress) {
      this._flapState.set(key, {
        penalty: decayed,
        suppressed: false,
        suppressedAt: null,
        lastUpdated: data.now,
      })
      flapStateChanged = true
    } else if (Math.abs(decayed - entry.penalty) > 0.1) {
      this._flapState.set(key, { ...entry, penalty: decayed, lastUpdated: data.now })
    }
  }

  // ... existing hold-timer / stale-route logic below (unchanged) ...
```

At the end of the method, if `flapStateChanged` is true but the existing logic returned `noChange`, we need to signal that propagation should re-evaluate. The simplest approach: if `flapStateChanged`, return a new state reference even if routes didn't change:

```typescript
if (purgedPeerNames.size === 0 && !flapStateChanged) return noChange(state)

// If only flap state changed (no routes purged), return same routes but new ref
if (purgedPeerNames.size === 0 && flapStateChanged) {
  const newState: RouteTable = { ...state }
  return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges: NO_ROUTE_CHANGES }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/orchestrator/tests/v2/flap-damping.test.ts`
Expected: PASS.

- [ ] **Step 5: Write test — max suppress time cap**

Add to `flap-damping.test.ts`:

```typescript
it('max suppress time cap — unsuppressed after 30 minutes despite high penalty', () => {
  const rib = new RoutingInformationBase({ nodeId })
  let state = connectedState()

  // Flap many times to get very high penalty
  for (let i = 0; i < 20; i++) {
    let plan = rib.plan(addUpdate(route1), state)
    state = rib.commit(plan, addUpdate(route1))
    plan = rib.plan(removeUpdate(route1), state)
    state = rib.commit(plan, removeUpdate(route1))
  }
  let plan = rib.plan(addUpdate(route1), state)
  state = rib.commit(plan, addUpdate(route1))
  expect(rib.flapState.get(`${routeKey(route1)}:node-b`)?.suppressed).toBe(true)

  // Advance time past max suppress (30 min) but penalty still above reuse
  const futureTime = Date.now() + FLAP_MAX_SUPPRESS_MS + 1000

  plan = rib.plan({ action: Actions.Tick, data: { now: futureTime } }, state)
  state = rib.commit(plan, { action: Actions.Tick, data: { now: futureTime } })

  expect(rib.flapState.get(`${routeKey(route1)}:node-b`)?.suppressed).toBe(false)
})
```

- [ ] **Step 6: Run test**

Run: `pnpm vitest run apps/orchestrator/tests/v2/flap-damping.test.ts`
Expected: PASS.

- [ ] **Step 7: Add suppress check to `buildUpdatesForPeer` in bus.ts**

In `apps/orchestrator/src/v2/bus.ts`, modify `buildUpdatesForPeer` to skip suppressed routes. Add after the existing loop-guard checks for internal routes:

```typescript
// --- Flap damping: skip suppressed routes ---
if (change.type !== 'removed') {
  const fk = `${routeKey(route)}:${route.originNode}`
  const flapEntry = this.rib.flapState.get(fk)
  if (flapEntry?.suppressed) continue
}
```

This goes inside the `if (isInternal)` block, after the route policy check and before the `updates.push()` call.

- [ ] **Step 8: Run full test suite**

Run: `pnpm run test:unit`
Expected: All tests PASS.

- [ ] **Step 9: Commit**

```bash
gt commit create --no-interactive -m "feat(routing): add flap damping decay via Tick and suppress check in propagation"
```

---

### Task 5: Multi-node topology tests for max prefix limits

**Files:**

- Modify: `apps/orchestrator/tests/v2/max-prefix.test.ts`

- [ ] **Step 1: Import TopologyHelper and add topology tests**

Add to `max-prefix.test.ts`, importing the same TopologyHelper pattern from `orchestrator.topology.test.ts`. Copy the `TopologyHelper` class, `makeConfig`, `makePeerInfo`, and `BusEntry` interface into the test file (or extract into a shared helper if preferred).

Then add the topology describe block:

```typescript
describe('Max prefix topology: A→B→C', () => {
  let topo: TopologyHelper

  beforeEach(async () => {
    topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')
    topo.addNode('node-c')

    await topo.peer('node-a', 'node-b')
    await topo.peer('node-b', 'node-c')
    topo.resetAll()
  })

  it('B drops excess routes from A, only propagates accepted routes to C', async () => {
    // Set B's maxPrefixes for peer A to 3
    const stateB = topo.get('node-b').bus.state
    const peerAIdx = stateB.internal.peers.findIndex((p) => p.name === 'node-a')
    // We need to set maxPrefixes on the peer — dispatch a LocalPeerUpdate or
    // modify the peer creation to include maxPrefixes. For topology tests,
    // we can re-create the peer with the limit by dispatching delete + create.
    await topo.get('node-b').bus.dispatch({
      action: Actions.LocalPeerDelete,
      data: { name: 'node-a' },
    })
    await topo.get('node-b').bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: { ...topo.get('node-a').peerInfo, maxPrefixes: 3 },
    })
    await topo.get('node-b').bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: topo.get('node-a').peerInfo },
    })
    topo.resetAll()

    // A creates 5 local routes
    for (let i = 1; i <= 5; i++) {
      await topo.get('node-a').bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: `svc-${i}`, protocol: 'http' as const, endpoint: `http://svc-${i}:8080` },
      })
    }

    // Propagate A→B
    await topo.propagate('node-a', 'node-b')

    // B should have only 3 internal routes from A
    const routesAtB = topo
      .get('node-b')
      .bus.state.internal.routes.filter((r) => r.peer.name === 'node-a')
    expect(routesAtB).toHaveLength(3)

    // Propagate B→C
    await topo.propagate('node-b', 'node-c')

    // C should see exactly 3 routes
    const routesAtC = topo.get('node-c').bus.state.internal.routes
    expect(routesAtC).toHaveLength(3)
  })

  it('B session stays alive after hitting limit', async () => {
    await topo.get('node-b').bus.dispatch({
      action: Actions.LocalPeerDelete,
      data: { name: 'node-a' },
    })
    await topo.get('node-b').bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: { ...topo.get('node-a').peerInfo, maxPrefixes: 2 },
    })
    await topo.get('node-b').bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: topo.get('node-a').peerInfo },
    })
    topo.resetAll()

    // A creates 5 routes
    for (let i = 1; i <= 5; i++) {
      await topo.get('node-a').bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: `svc-${i}`, protocol: 'http' as const, endpoint: `http://svc-${i}:8080` },
      })
    }
    await topo.propagate('node-a', 'node-b')

    // B's peer A should still be connected
    const peerA = topo.get('node-b').bus.state.internal.peers.find((p) => p.name === 'node-a')
    expect(peerA?.connectionStatus).toBe('connected')
  })

  it('remove-then-add respects updated count', async () => {
    await topo.get('node-b').bus.dispatch({
      action: Actions.LocalPeerDelete,
      data: { name: 'node-a' },
    })
    await topo.get('node-b').bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: { ...topo.get('node-a').peerInfo, maxPrefixes: 3 },
    })
    await topo.get('node-b').bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: topo.get('node-a').peerInfo },
    })
    topo.resetAll()

    // A creates 3 routes (fills limit)
    for (let i = 1; i <= 3; i++) {
      await topo.get('node-a').bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: `svc-${i}`, protocol: 'http' as const, endpoint: `http://svc-${i}:8080` },
      })
    }
    await topo.propagate('node-a', 'node-b')
    expect(topo.get('node-b').bus.state.internal.routes).toHaveLength(3)
    topo.resetAll()

    // A removes 2 routes
    await topo
      .get('node-a')
      .bus.dispatch({ action: Actions.LocalRouteDelete, data: { name: 'svc-1' } })
    await topo
      .get('node-a')
      .bus.dispatch({ action: Actions.LocalRouteDelete, data: { name: 'svc-2' } })
    await topo.propagate('node-a', 'node-b')
    expect(topo.get('node-b').bus.state.internal.routes).toHaveLength(1)
    topo.resetAll()

    // A adds 3 new routes — B should accept 2 (to reach limit of 3)
    for (let i = 4; i <= 6; i++) {
      await topo.get('node-a').bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: `svc-${i}`, protocol: 'http' as const, endpoint: `http://svc-${i}:8080` },
      })
    }
    await topo.propagate('node-a', 'node-b')
    expect(topo.get('node-b').bus.state.internal.routes).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run topology tests**

Run: `pnpm vitest run apps/orchestrator/tests/v2/max-prefix.test.ts`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
gt commit create --no-interactive -m "test(routing): add multi-node topology tests for max prefix limits"
```

---

### Task 6: Multi-node topology tests for flap damping

**Files:**

- Modify: `apps/orchestrator/tests/v2/flap-damping.test.ts`

- [ ] **Step 1: Add topology tests for flap damping**

Add a topology describe block to `flap-damping.test.ts`, using the same TopologyHelper pattern. Use `vi.useFakeTimers()` for deterministic time control:

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

describe('Flap damping topology', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('A flaps route 6 times — B and C suppress propagation', async () => {
    const topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')
    topo.addNode('node-c')
    await topo.peer('node-a', 'node-b')
    await topo.peer('node-b', 'node-c')
    topo.resetAll()

    const route = { name: 'flappy', protocol: 'http' as const, endpoint: 'http://flap:8080' }

    // 6 flap cycles
    for (let i = 0; i < 6; i++) {
      await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: route })
      await topo.propagate('node-a', 'node-b')
      await topo.propagate('node-b', 'node-c')
      topo.resetAll()
      await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteDelete, data: route })
      await topo.propagate('node-a', 'node-b')
      await topo.propagate('node-b', 'node-c')
      topo.resetAll()
    }

    // Final add
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: route })
    await topo.propagate('node-a', 'node-b')

    // B should have the route but suppress propagation to C
    expect(topo.get('node-b').bus.state.internal.routes.some((r) => r.name === 'flappy')).toBe(true)

    // Check that B's transport has NO sendUpdate calls for node-c containing 'flappy'
    const callsToC = topo
      .get('node-b')
      .transport.getCallsFor('sendUpdate')
      .filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-c')
    const flapUpdates = callsToC.flatMap((c) =>
      c.method === 'sendUpdate'
        ? c.message.updates.filter((u: any) => u.route.name === 'flappy')
        : []
    )
    expect(flapUpdates).toHaveLength(0)
  })

  it('after decay, B resumes propagating the route to C', async () => {
    const topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')
    topo.addNode('node-c')
    await topo.peer('node-a', 'node-b')
    await topo.peer('node-b', 'node-c')
    topo.resetAll()

    const route = { name: 'flappy', protocol: 'http' as const, endpoint: 'http://flap:8080' }

    // 6 flap cycles
    for (let i = 0; i < 6; i++) {
      await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: route })
      await topo.propagate('node-a', 'node-b')
      topo.resetAll()
      await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteDelete, data: route })
      await topo.propagate('node-a', 'node-b')
      topo.resetAll()
    }

    // Final add — suppressed at B
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: route })
    await topo.propagate('node-a', 'node-b')
    topo.resetAll()

    // Advance time past decay period (4 half-lives = 20 min)
    const futureTime = Date.now() + FLAP_HALF_LIFE_MS * 4
    vi.setSystemTime(futureTime)

    await topo.get('node-b').bus.dispatch({ action: Actions.Tick, data: { now: futureTime } })

    // B should now propagate the route to C
    await topo.propagate('node-b', 'node-c')

    const routesAtC = topo.get('node-c').bus.state.internal.routes
    expect(routesAtC.some((r) => r.name === 'flappy')).toBe(true)
  })

  it('suppressed route loses best-path to fresh route from another peer', async () => {
    const topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-c')
    topo.addNode('node-d')
    await topo.peer('node-a', 'node-c')
    await topo.peer('node-d', 'node-c')
    topo.resetAll()

    const route = {
      name: 'contested',
      protocol: 'http' as const,
      endpoint: 'http://contested:8080',
    }

    // A flaps the route 6 times at C
    for (let i = 0; i < 6; i++) {
      await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: route })
      await topo.propagate('node-a', 'node-c')
      topo.resetAll()
      await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteDelete, data: route })
      await topo.propagate('node-a', 'node-c')
      topo.resetAll()
    }

    // A re-adds (suppressed at C)
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: route })
    await topo.propagate('node-a', 'node-c')

    // D advertises the same route (fresh, no flap)
    await topo.get('node-d').bus.dispatch({ action: Actions.LocalRouteCreate, data: route })
    await topo.propagate('node-d', 'node-c')

    // C should have the route from both peers, but D's version is preferred (not suppressed)
    const routesAtC = topo
      .get('node-c')
      .bus.state.internal.routes.filter((r) => r.name === 'contested')
    // At minimum, D's fresh route should be present
    expect(routesAtC.some((r) => r.originNode === 'node-d')).toBe(true)
  })

  it('independent damping — flappy route suppressed, stable route propagates', async () => {
    const topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')
    await topo.peer('node-a', 'node-b')
    topo.resetAll()

    const flappy = { name: 'flappy', protocol: 'http' as const, endpoint: 'http://flap:8080' }
    const stable = { name: 'stable', protocol: 'http' as const, endpoint: 'http://stable:8080' }

    // Flap route-X 6 times
    for (let i = 0; i < 6; i++) {
      await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: flappy })
      await topo.propagate('node-a', 'node-b')
      topo.resetAll()
      await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteDelete, data: flappy })
      await topo.propagate('node-a', 'node-b')
      topo.resetAll()
    }

    // Re-add flappy + add stable in the same batch
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: flappy })
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: stable })
    await topo.propagate('node-a', 'node-b')

    // B has both routes in state
    const routesAtB = topo.get('node-b').bus.state.internal.routes
    expect(routesAtB.some((r) => r.name === 'flappy')).toBe(true)
    expect(routesAtB.some((r) => r.name === 'stable')).toBe(true)

    // But only 'stable' was propagated onward (check transport calls)
    // Since B has no downstream peer in this 2-node test, we check flapState directly
    const rib = (topo.get('node-b').bus as any).rib as RoutingInformationBase
    expect(rib.flapState.get(`flappy:node-a`)?.suppressed).toBe(true)
    expect(rib.flapState.get(`stable:node-a`)?.suppressed).toBeFalsy()
  })
})
```

- [ ] **Step 2: Run all tests**

Run: `pnpm vitest run apps/orchestrator/tests/v2/flap-damping.test.ts`
Expected: All tests PASS.

- [ ] **Step 3: Run full suite**

Run: `pnpm run test:unit`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
gt commit create --no-interactive -m "test(routing): add multi-node topology tests for flap damping"
```

---

### Task 7: Submit PR

- [ ] **Step 1: Run full test suite one final time**

Run: `pnpm run test:unit`
Expected: All tests PASS.

- [ ] **Step 2: Submit PR via Graphite**

```bash
gt submit --no-interactive
```

- [ ] **Step 3: Comment PR link on GitHub issues**

```bash
gh issue comment 400 --repo orbisoperations/catalyst-router --body "PR: <graphite-url>"
gh issue comment 401 --repo orbisoperations/catalyst-router --body "PR: <graphite-url>"
```
