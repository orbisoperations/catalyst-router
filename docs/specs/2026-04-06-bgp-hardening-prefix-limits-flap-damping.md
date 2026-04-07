# BGP Hardening: Max Prefix Limits & Route Flap Damping

**Date:** 2026-04-06
**Issues:** [#400](https://github.com/orbisoperations/catalyst-router/issues/400), [#401](https://github.com/orbisoperations/catalyst-router/issues/401)
**Status:** Draft
**References:** RFC 2439, RFC 7196 (BCP 194), RIPE-580

## Problem

The BGP-like routing protocol in catalyst-router currently accepts all routes unconditionally and propagates every state change immediately. Two classes of misbehavior are unprotected:

1. **Prefix flooding:** A peer advertising thousands of routes can exhaust RIB memory and port allocator capacity.
2. **Route flapping:** A service that crashes and restarts repeatedly causes withdrawal/re-advertisement cycles that cascade across the entire mesh.

## Scope

This spec covers two independent safety features:

- **Max prefix limits per peer** (GitHub #400) — drop excess routes when a peer exceeds a configured threshold.
- **Route flap damping** (GitHub #401) — suppress routes that oscillate rapidly, preventing churn propagation.

Route filters (GitHub #403) are out of scope and will be designed separately.

---

## Feature 1: Max Prefix Limits

### Behavior

A per-peer `maxPrefixes` field controls the maximum number of internal routes accepted from that peer. Routes are processed individually within each update batch. When the count reaches the limit, excess `'add'` actions in the batch are silently dropped. `'remove'` actions are always processed regardless of the limit.

This follows the Juniper `drop-excess` model — the most graceful approach found in production BGP implementations. The session stays alive, accepted routes remain valid, and only excess routes are dropped. This avoids the "teardown spiral" problem where session teardown deletes all routes, the peer reconnects and re-advertises, and the session tears down again.

- `maxPrefixes: undefined` or `maxPrefixes: 0` — unlimited (default, backward compatible).
- A **warning log** is emitted when the peer reaches 80% of the limit (standard practice across Cisco, Juniper, FRR).
- A **drop log** is emitted for each excess route that is dropped.
- The count is per-peer, not global.

### Type Changes

**`PeerRecord`** (`packages/routing/src/v2/state.ts`):

```typescript
type PeerRecord = PeerInfo & {
  // ... existing fields ...
  maxPrefixes?: number // NEW — 0 or undefined = unlimited
}
```

**`LocalPeerCreate` action data** (`packages/routing/src/v2/internal/actions.ts`):

```typescript
// Add maxPrefixes to the peer create schema
maxPrefixes: z.number().int().min(0).optional()
```

### Implementation Location

`planInternalProtocolUpdate()` in `packages/routing/src/v2/rib/rib.ts`:

```
// Pseudocode — inside the route processing loop
const peer = state.internal.peers.find(p => p.name === data.peerInfo.name)
const limit = peer?.maxPrefixes
if (limit && limit > 0) {
  let currentCount = state.internal.routes.filter(r => r.peer.name === peer.name).length

  // Warn at 80% threshold
  if (currentCount >= Math.floor(limit * 0.8)) {
    // log warning via WideEvent
  }

  // For each 'add' in the batch: skip if currentCount >= limit
  // For each 'remove': always process, decrement currentCount
}
```

### CLI

```bash
catalyst node peer create node-b ws://node-b:3000/rpc --max-prefixes 50
```

### Tests (7)

1. Accept routes up to exactly the limit
2. Excess routes in a batch are individually dropped (earlier routes in batch accepted)
3. Remove routes below limit, then add more — succeeds
4. `maxPrefixes: 0` means unlimited
5. Peer with no `maxPrefixes` set works unchanged (backward compat)
6. Count is per-peer — peer A at limit doesn't affect peer B
7. Warning logged when peer reaches 80% of limit

---

## Feature 2: Route Flap Damping

### Design Rationale

Based on RFC 2439, RFC 7196, and RIPE-580 recommendations. Key adaptations for our small mesh (2-20 nodes):

- **Suppress threshold raised to 6000** (from vendor default of 2000) per RFC 7196/RIPE-580. This prevents a single legitimate failover (which can generate 3-4 updates via path exploration) from suppressing routes.
- **Half-life of 5 minutes** (shorter than the internet standard of 15 minutes). Our mesh is small and flaps resolve faster than internet-scale instability. A shorter half-life means routes recover more quickly.
- **Max suppress time of 30 minutes** (shorter than the 60-minute internet standard). In a small mesh, suppressing a route for an hour could be catastrophic for reachability.
- **Cisco penalty model** — penalty increments only on the withdraw-then-re-add cycle, not on each individual event. Simpler and avoids the threshold-doubling complexity of the Juniper model.

### Constants

Hardcoded with sensible defaults. Can be promoted to config later.

```typescript
const FLAP_PENALTY_INCREMENT = 1000 // per flap cycle (withdraw then re-add)
const FLAP_SUPPRESS_THRESHOLD = 6000 // RFC 7196/RIPE-580 minimum
const FLAP_REUSE_THRESHOLD = 750 // standard value
const FLAP_HALF_LIFE_MS = 300_000 // 5 minutes (adapted for small mesh)
const FLAP_MAX_SUPPRESS_MS = 1_800_000 // 30 minutes cap
```

With these values: a route must flap 6 times within the decay window to be suppressed. After suppression, it recovers in ~12-15 minutes assuming no further flaps (penalty decays from 6000 through reuse threshold of 750 over ~3.5 half-lives).

### State

A new `flapState` Map on the RIB instance (not part of `RouteTable`):

```typescript
// Key: `${routeKey}:${originNode}`
private flapState: Map<string, {
  penalty: number
  suppressed: boolean
  suppressedAt: number | null  // epoch ms, for max-suppress-time enforcement
  lastUpdated: number          // epoch ms, for decay calculation
}>
```

This state is **ephemeral** — it does not survive restart. On restart, all penalties reset to zero. Rationale: if the node restarted, the flapping condition likely resolved, and we'd rather re-learn routes optimistically than start suppressed with stale penalty data.

### How It Works

**On `planInternalProtocolUpdate`:**

- For each `'remove'` update: ensure a flapState entry exists (create with penalty=0 if not). This marks the route as "recently withdrawn" so the next add can detect the flap.
- For each `'add'` update: check if a flapState entry exists with non-zero penalty (meaning it was recently removed). If so, apply decay since `lastUpdated`, then increment penalty by `FLAP_PENALTY_INCREMENT`.
- If penalty >= `FLAP_SUPPRESS_THRESHOLD`: set `suppressed = true`, `suppressedAt = now`. The route is still accepted into the RIB but marked as suppressed for propagation and best-path purposes.
- A re-announcement of an identical existing route does NOT increment penalty (per RFC 2439).

**On `Tick`:**

- Iterate flapState entries. Apply exponential decay: `penalty *= Math.pow(0.5, elapsed / FLAP_HALF_LIFE_MS)`.
- If `suppressed === true` and either:
  - penalty < `FLAP_REUSE_THRESHOLD`, OR
  - `now - suppressedAt > FLAP_MAX_SUPPRESS_MS`
    then set `suppressed = false`, `suppressedAt = null`. This constitutes a state change that triggers propagation of the now-unsuppressed route.
- Prune entries where penalty rounds to zero (< 1).

**In propagation (`buildUpdatesForPeer` in `bus.ts`):**

- Suppressed routes (where `flapState.get(key)?.suppressed === true`) are excluded from outbound updates.

**In best-path selection:**

- Suppressed routes are deprioritized (treated as infinite path length).

### Tests (7)

1. Single withdraw/re-add below threshold — route stays usable, propagated normally
2. Six rapid flaps exceed threshold (6000) — route suppressed, not propagated
3. Suppressed route excluded from best-path (fresh route from another peer wins)
4. Tick decays penalty — suppressed route becomes reusable after sufficient decay
5. Different routes from same peer damped independently
6. Suppressed route not included in outbound updates to any peer
7. Max suppress time cap — route unsuppressed after 30 minutes even if penalty still high

---

## Interaction Between Features

The two features are independent and operate at different stages:

- **Max prefix limits** gate at the "should I accept this route?" stage (entry to RIB). Excess routes are dropped before entering the route table.
- **Flap damping** gates at the "should I propagate/prefer this route?" stage (exit from RIB). Routes are accepted but suppressed for propagation.

A dropped route (due to prefix limits) does not trigger flap damping since it was never accepted into the RIB.

---

## Testing Strategy

Three layers of testing, totaling ~22 tests.

### Layer 1: RIB Unit Tests (~14 tests)

Test `plan()` directly against the state machine. Fast, deterministic, cover all edge cases.

**Max prefix limit unit tests (7):**

1. Accept routes up to exactly the limit
2. Excess routes in a batch are individually dropped (earlier routes in batch accepted)
3. Remove routes below limit, then add more — succeeds
4. `maxPrefixes: 0` means unlimited
5. Peer with no `maxPrefixes` set works unchanged (backward compat)
6. Count is per-peer — peer A at limit doesn't affect peer B
7. Warning logged when peer reaches 80% of limit

**Flap damping unit tests (7):**

1. Single withdraw/re-add below threshold — route stays usable, propagated normally
2. Six rapid flaps exceed threshold (6000) — route suppressed, not propagated
3. Suppressed route excluded from best-path (fresh route from another peer wins)
4. Tick decays penalty — suppressed route becomes reusable after sufficient decay
5. Different routes from same peer damped independently
6. Suppressed route not included in outbound updates to any peer
7. Max suppress time cap — route unsuppressed after 30 minutes even if penalty still high

### Layer 2: Multi-Node Topology Tests (~8 tests)

Uses the existing `TopologyHelper` pattern from `orchestrator.topology.test.ts` — multiple real `OrchestratorBus` instances wired together with `MockPeerTransport` and manual `propagate()` calls. These test the full dispatch → plan → commit → post-commit → propagation cycle across nodes. Uses `vi.useFakeTimers()` for deterministic time control.

**Max prefix topology tests (3):**

1. **Drop-excess propagation (A→B→C):** A advertises 7 routes to B. B has `maxPrefixes: 5`. B accepts 5, drops 2, and only propagates 5 onward to C. Verify C sees exactly 5 routes.
2. **Chain isolation (A→B→C):** B hits prefix limit from A. Verify C never sees the excess routes and B's session with A stays alive.
3. **Remove-then-add (A→B):** A removes 2 routes from B, then adds 3 more in a new update. B accepts up to the limit. Verify the count is correct after mixed add/remove operations.

**Flap damping topology tests (5):**

4. **Suppress propagation (A→B, A→C):** A advertises a route to B and C. A withdraws and re-adds the route 6 times rapidly via dispatched updates. Propagate each cycle to B and C. Verify B and C suppress the route and stop propagating it further.
5. **Recovery after decay (A→B→C):** After suppression in test 4 scenario, advance time via `Tick` with fake timers until penalty decays below reuse threshold. Verify B and C resume propagating the route to downstream peers.
6. **Best-path deprioritization (A→C, D→C):** A flaps a route. C suppresses A's route. Meanwhile D advertises a fresh route for the same destination. Verify C prefers D's fresh route over A's suppressed route.
7. **Max suppress time cap (A→B):** A flaps a route continuously, keeping the penalty high. Advance time past 30 minutes. Verify B unsuppresses the route despite high penalty.
8. **Independent damping (A→B):** A flaps route-X rapidly (6 flaps, gets suppressed). A also advertises route-Y with no flaps. Verify route-X is suppressed while route-Y propagates normally through the mesh.

### Layer 3: CLI Manual Verification

A documented set of steps to run against a 2-node docker-compose for human verification. Included as a comment block or markdown file alongside the tests.

**Max prefix manual test:**

```bash
# Terminal 1: Start 2-node docker-compose
docker compose -f docker-compose.multi.yml up

# Terminal 2: Create peer with limit
catalyst --orchestrator-url ws://localhost:3001/rpc \
  node peer create node-b ws://localhost:3002/rpc --max-prefixes 3

# Add routes from node-b until limit
catalyst --orchestrator-url ws://localhost:3002/rpc \
  node route create svc-1 http://svc1:8080 --protocol http
# ... repeat for svc-2, svc-3, svc-4, svc-5

# Verify node-a only sees 3 routes from node-b
catalyst --orchestrator-url ws://localhost:3001/rpc \
  node route list
```

**Flap damping manual test:**

```bash
# Rapidly create/delete a route on node-b
for i in $(seq 1 6); do
  catalyst --orchestrator-url ws://localhost:3002/rpc \
    node route create flappy http://flap:8080 --protocol http
  sleep 0.5
  catalyst --orchestrator-url ws://localhost:3002/rpc \
    node route delete flappy
  sleep 0.5
done

# Re-add the route
catalyst --orchestrator-url ws://localhost:3002/rpc \
  node route create flappy http://flap:8080 --protocol http

# Verify node-a does NOT see "flappy" (suppressed)
catalyst --orchestrator-url ws://localhost:3001/rpc \
  node route list

# Wait ~15 minutes, check again — should appear
catalyst --orchestrator-url ws://localhost:3001/rpc \
  node route list
```

---

## Branch Strategy

Single branch off `main`, two logical commits (one per feature), one PR. Both features touch `rib.ts` but in different code paths.

## Files Changed

| File                                              | Changes                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/routing/src/v2/state.ts`                | Add `maxPrefixes?` to `PeerRecord`                                       |
| `packages/routing/src/v2/rib/rib.ts`              | Per-route prefix limit check, flap state tracking, suppress in best-path |
| `packages/routing/src/v2/internal/actions.ts`     | Add `maxPrefixes?` to `LocalPeerCreate` data schema                      |
| `apps/orchestrator/src/v2/bus.ts`                 | Suppress check in `buildUpdatesForPeer` propagation                      |
| `apps/orchestrator/tests/v2/max-prefix.test.ts`   | 7 unit tests + 3 topology tests                                          |
| `apps/orchestrator/tests/v2/flap-damping.test.ts` | 7 unit tests + 5 topology tests                                          |
