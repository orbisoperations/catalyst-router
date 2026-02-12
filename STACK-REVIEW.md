# Stack Code Review: Orchestrator BGP-Inspired Refactoring

**Stack**: 28 PRs (#353 → #389) on `refactor_orchestrator_fix_package_boundary_violations` through `test-catalog-docs`
**Scope**: ~9,400 lines added, ~960 deleted across 52 files
**Reviewer**: Claude Opus 4.6
**Date**: 2026-02-18

---

## Executive Summary

This stack decomposes a monolithic `CatalystNodeBus` orchestrator into clean, testable components — `PeerTransport`, `ActionQueue`, `RoutingInformationBase` (RIB), and `ConnectionPool` — using a BGP-inspired plan/commit pipeline. It then adds features (keepalive, best-path metadata, port operations), comprehensive test coverage (200+ tests), documentation, and a bug fix.

**The architecture is sound.** The plan/commit separation is well-designed, the decomposition is clean, and the test suite is impressively thorough with real BGP edge cases.

**There are 3 blocking issues, 6 high-severity issues, and 11 medium-severity issues** that should be addressed before merging the full stack.

### Verdict by PR Group

| PRs | Group | Verdict |
|-----|-------|---------|
| 1-6 | Core refactoring | **Approve with fixes** (circular dep, fire-and-forget propagation) |
| 7-10 | Features | **Block on PR 7** (keepalive no-op, holdTime=0 semantics) |
| 11 | Documentation | **Approve** (minor nit on tie-breaking docs) |
| 12-21 | Test suite | **Approve with fixes** (helper duplication, conditional assertions) |
| 22-24 | Test reorganization | **Approve** |
| 25 | More tests | **Approve** |
| 26 | Bug fix | **Approve** (but should be earlier in stack; related port leak still exists) |
| 27 | Coverage tests | **Approve** |
| 28 | Test catalog | **Approve** |

---

## Blocking Issues

### B1. `sendKeepalive()` is a no-op — remote peers will always expire

**File**: `apps/orchestrator/src/peer-transport.ts:82-87`
**PR**: #359 (feat: tick-based keepalive)

```typescript
async sendKeepalive(peer: PeerRecord): Promise<void> {
  this.logger.debug`Sending keepalive to ${peer.name}`
  // Keepalive is a no-op RPC ping. For now we use a zero-update message
  // as the transport-level heartbeat.
}
```

The `commit()` method updates `lastSent` for peers receiving keepalive propagations (rib.ts:117-119), so the local node believes it sent a keepalive, but nothing hits the wire. Remote peers' hold timers will never be reset, causing them to expire even when the connection is healthy.

Additionally, the `Propagation` type for keepalive (`{ type: 'keepalive'; peer: PeerRecord }`) lacks the `localNode` field needed by the transport layer — a structural gap that prevents implementation.

**Fix**: Either implement `sendKeepalive` to send an empty update message, or do not update `lastSent` for keepalive propagations until the transport actually sends something. Add `localNode` to the keepalive propagation variant.

---

### B2. `holdTime=0` causes immediate peer expiry instead of "never expire"

**File**: `apps/orchestrator/src/rib.ts:469-478`
**PR**: #359 (feat: tick-based keepalive)

```typescript
if (
  peer.connectionStatus === 'connected' &&
  peer.holdTime != null &&
  // Missing: peer.holdTime > 0
  peer.lastReceived != null &&
  now - peer.lastReceived > peer.holdTime * 1000
)
```

Per RFC 4271 Section 4.2, `holdTime=0` means "hold timer is not started" (the peer never expires). The current implementation treats it as a 0ms threshold, causing immediate expiry on the first tick. The test at `bgp-hold-timer-edge-cases.test.ts:78` documents this deviation but does not flag it as a bug.

**Fix**: Add `peer.holdTime > 0` guard to both the expiry check (rib.ts:471) and the keepalive check (rib.ts:697).

---

### B3. Circular dependency: `connection-pool.ts` ↔ `orchestrator.ts`

**File**: `apps/orchestrator/src/connection-pool.ts:7`
**PR**: #355 (extract PeerTransport)

```typescript
// connection-pool.ts (lowest layer)
import type { PublicApi } from './orchestrator.js'

// orchestrator.ts (highest layer)
import { ConnectionPool } from './connection-pool.js'
```

The connection pool (infrastructure layer) depends on the orchestrator's public API type (application layer), inverting the dependency direction the entire stack is trying to establish. While `import type` makes this work at runtime, it couples the lowest layer to the highest.

**Fix**: Extract `PublicApi` and sibling interfaces into a dedicated `api-types.ts` that both modules import from.

---

## High Severity Issues

### H1. `handlePostCommit` is fire-and-forget with no error surfacing

**File**: `apps/orchestrator/src/orchestrator.ts:252-256`

`dispatch()` returns `{ success: true }` before propagation, Envoy sync, or GraphQL sync completes. For a BGP-inspired system, route propagation failure is a correctness issue — node A adds a route and propagation to node B silently fails, leaving the network inconsistent with no repair mechanism.

**Recommendation**: Surface propagation failures in `DispatchResult` (e.g., `{ success: true, propagationErrors?: string[] }`) or implement a periodic reconciliation loop via the Tick mechanism.

---

### H2. No timeout on RPC calls in PeerTransport

**File**: `apps/orchestrator/src/peer-transport.ts:38-48`

Both `stub.getIBGPClient(token)` and `result.client.update(...)` are unguarded async calls. If a remote peer is unresponsive, `Promise.allSettled` in `fanOut` prevents one peer from blocking others, but `handlePostCommit` can still hang indefinitely.

**Recommendation**: Wrap RPC calls with `AbortSignal.timeout`.

---

### H3. `LocalPeerDelete` does not release egress ports — port leak

**File**: `apps/orchestrator/src/rib.ts:206-214`

`Actions.LocalPeerDelete` is not in the `computePortOps` allow-list. When you delete a peer that had learned routes with allocated egress ports, routes are correctly removed from state but ports are never released. Under repeated peer churn with Envoy enabled, this exhausts the port range.

**Fix**: Add `Actions.LocalPeerDelete` to `routeActions` and add release logic for the deleted peer's routes.

---

### H4. Tick-based peer expiry also does not release egress ports

**File**: `apps/orchestrator/src/rib.ts:206-214`

Same class of bug as H3. `Actions.Tick` is not in the `routeActions` allow-list, so hold timer expiry removes routes from state but leaks allocated egress ports.

**Fix**: Add `Actions.Tick` to `routeActions` with release logic mirroring the expired peer route removal.

---

### H5. `commit()` does not validate plan staleness

**File**: `apps/orchestrator/src/rib.ts:103-104`

No assertion that `plan.prevState === this.state`. While the ActionQueue serializes plan+commit pairs, `commit()` is a public method. Test helpers already exploit this (e.g., `setPeerTimingFields` constructs synthetic plans), but a future caller could misuse it to silently corrupt state.

**Fix**: Add a guard: `if (plan.prevState !== this.state) throw new Error('Stale plan')`.

---

### H6. `stampPortsOnState` semantics may confuse state consumers

**File**: `apps/orchestrator/src/rib.ts:180-192`

Internal routes in `getState()` carry the **remote** peer's `envoyPort`, not the local egress port. The propagation layer correctly rewrites ports via `buildRouteSyncPayload`, but any direct consumer of `getState()` (e.g., Envoy config generation) could use the wrong port.

**Recommendation**: Document the semantics clearly in the `InternalRoute` type or add a separate `localEgressPort` field.

---

## Medium Severity Issues

### M1. Dead types in `types.ts`

**File**: `apps/orchestrator/src/types.ts:26-31`

`StateResult` and `NotificationResult` are exported but never imported. They reference concepts (`nextActions`) that no longer exist in the plan/commit model. Remove them.

---

### M2. `@ts-expect-error` for Envoy and Gateway RPC stubs

**File**: `apps/orchestrator/src/orchestrator.ts:294,327`

The `ConnectionPool` is typed as `Map<string, RpcStub<PublicApi>>` but also serves Envoy and Gateway stubs with different APIs. Two `@ts-expect-error` annotations paper over this type hole.

**Recommendation**: Use separate typed pool instances or define a union type.

---

### M3. Tick interval computed once at startup, never updated

**File**: `apps/orchestrator/src/orchestrator.ts:164-173`

`computeTickInterval()` reads peer hold times at `startTick()` time. New peers with shorter hold times will not cause the interval to be recalculated, potentially expiring them before a keepalive fires.

**Recommendation**: Recalculate on peer state changes or use a fixed conservative interval.

---

### M4. No tick dispatch backpressure

**File**: `apps/orchestrator/src/orchestrator.ts:168-172`

`setInterval` fires regardless of whether the previous tick completed. Under high load, tick actions accumulate unboundedly in the ActionQueue.

**Fix**: Add a `tickInFlight` boolean guard to skip dispatch if the previous tick hasn't completed.

---

### M5. Port allocation failure silently swallowed in `commit()`

**File**: `apps/orchestrator/src/rib.ts:155-167`

When port allocation fails (e.g., pool exhausted), the error is logged but commit proceeds. The route exists in state without an `envoyPort`, making it unroutable via Envoy.

**Recommendation**: Either fail the commit or mark the route as degraded.

---

### M6. Tests use `setTimeout` for propagation timing

**File**: `apps/orchestrator/tests/orchestrator.topology.test.ts:91,104,186`

Classic flaky-test pattern. On slow CI machines, 100-150ms may not be enough.

**Fix**: Consistently use `lastNotificationPromise` or expose a `drain()` method for deterministic synchronization.

---

### M7. `getState()` returns mutable reference to internal state

**File**: `apps/orchestrator/src/rib.ts:59-61`

External callers can mutate the RIB's internal state, bypassing the plan/commit pipeline.

**Recommendation**: Document the immutability contract or return a frozen copy.

---

### M8. ~700 lines of duplicated test helpers across 23+ files

Every test file copies the same `createRib`, `planCommit`, `connectPeer`, `setPeerTimingFields` helpers and `NODE`/`PEER_B`/`PEER_C`/`PEER_D` constants.

**Fix**: Extract into `apps/orchestrator/tests/rib-test-helpers.ts`.

---

### M9. Conditional assertion anti-pattern in multiple test files

Pattern found in PRs 12, 16, 17, 19, 20, 21:

```typescript
const found = result.propagations.find(p => p.type === 'update')
expect(found).toBeDefined()
if (found && found.type === 'update') {
  expect(found.update.updates).toHaveLength(2) // silently skipped if condition is false
}
```

**Fix**: Use type assertion (`as Extract<...>`) or non-null assertion after `toBeDefined()`.

---

### M10. `setPeerTimingFields` fabricates synthetic plans bypassing pipeline

**File**: `apps/orchestrator/tests/keepalive.test.ts:43-71`

Used in hold timer and propagation tests. Wipes `routeMetadata` to an empty Map, could produce impossible states.

**Recommendation**: Accept the backdoor but document it, or add a test-only `_setState()` method.

---

### M11. Best-path tie-breaking test doesn't verify determinism

**File**: `apps/orchestrator/tests/bgp-best-path-selection.test.ts:100-102`

Test asserts the winner is one of two candidates but not that the choice is deterministic. The production code relies on `Array.sort` stability.

**Fix**: Add a `peerName.localeCompare` tiebreaker to production code for operational determinism.

---

## Low Severity / Nits

| # | Issue | File | Notes |
|---|-------|------|-------|
| L1 | `Propagation` type imported into RIB from peer-transport | rib.ts:14 | Could live in shared types file |
| L2 | `import type { z } from 'zod'` in orchestrator/peer-transport | orchestrator.ts:1 | Could import inferred type directly from `@catalyst/routing` |
| L3 | `ConnectionPool` constructor defaults inconsistent | orchestrator.ts:128-133 | Nested ternary harder to read than needed |
| L4 | `DataChannelDefinitionSchema` re-exported as `ServiceDefinitionSchema` | index.ts | Undocumented backward-compat alias |
| L5 | README tie-breaking docs slightly imprecise | README.md:250-253 | States "first received wins" but code relies on sort stability |
| L6 | `Math.min(...holdTimes)` stack overflow with large arrays | orchestrator.ts:190 | Use `reduce` instead of spread |
| L7 | `stopTick()` never called from any lifecycle hook | orchestrator.ts:175-180 | Timer leaks on shutdown |
| L8 | Test catalog count "206 tests" will drift | TEST-CATALOG.md:6 | Consider generating from test output |
| L9 | Type cast `as Plan` used instead of type narrowing in tests | multiple test files | Use `if (!plan.success) throw` pattern |
| L10 | No test for unknown action type default branch | rib.ts:493-496 | Logs warning but returns success; untested |

---

## Stack Ordering Assessment

### Current Order (28 PRs)

```
1.  refactor: fix package boundary violations       (#353, ready to merge)
2.  feat: add Tick action type                       (#354)
3.  refactor: extract PeerTransport                  (#355)
4.  refactor: add ActionQueue                        (#356)
5.  refactor: extract RIB with plan/commit           (#357)
6.  refactor: reduce to thin shell                   (#358)
7.  feat: tick-based keepalive                       (#359)  ← BLOCKER: keepalive no-op
8.  feat: route metadata / best path                 (#360)
9.  refactor: PortOperation type                     (#369)
10. refactor: pure plan / side-effectful commit      (#370)
11. docs: routing README                             (#371)
12-21. tests: BGP edge cases (10 PRs)                (#372-381)
22-24. refactor: test reorganization (3 PRs)         (#382-384)
25. tests: zombie/port tests                         (#386)
26. fix: zombie route cleanup on LocalPeerDelete     (#387)  ← BUG FIX
27. tests: 36 coverage gap tests                     (#388)
28. docs: test catalog                               (#389)
```

### Recommendations

1. **PR 26 (bug fix) should be earlier** — before the test PRs that exercise the behavior it fixes. This makes the git history tell a clearer story: "fix the bug, then prove it's fixed."

2. **PRs 22-24 (test reorg) could be squashed** — moving tests to `unit/`, renaming, and splitting are logically one "reorganize test structure" change. Three PRs for this adds review overhead without proportional benefit.

3. **The 10 test PRs (12-21) are individually small and focused** — this is fine for a stack. Each covers one BGP concept and stands alone.

4. **Tests should ideally be co-located with features** — the keepalive tests (PR 18) should ship with the keepalive feature (PR 7), and port allocation tests (PR 20) with the PortOperation PRs (9-10). This stack separates them, which makes each feature PR harder to validate in isolation.

5. **The feature PRs (7-10) should be blocked until the keepalive no-op (B1) and holdTime=0 (B2) are fixed** — they're structurally incomplete without a working transport.

---

## Security Review

No security issues identified. Token handling in `PeerTransport.getToken()` correctly enforces peerToken/nodeToken presence. The `validateToken` flow delegates to an external auth service. No secrets are logged.

---

## Performance Notes

- **ActionQueue serialization** is the intentional bottleneck — correct for BGP consistency semantics
- **`fanOut` with `Promise.allSettled`** correctly parallelizes peer propagation
- **`computePortOps`** and **`computeRouteMetadata`** iterate all routes on every relevant action — acceptable at current scale but O(n) per action
- **`buildRouteSyncPayload`** creates new arrays on every call — fine for initial sync
- **Best-path `.sort()` runs on every plan** — O(n log n) per route name, acceptable but indexable later

---

## Missing Test Coverage

| Gap | Severity | Notes |
|-----|----------|-------|
| Orchestrator `pipeline()` integration path | Medium | plan → commit → handlePostCommit → syncEnvoy → syncGraphql untested as a unit |
| `syncEnvoy` / `syncGraphql` action filtering | Medium | Which actions trigger these syncs? |
| `startTick()` / `stopTick()` lifecycle | Medium | No test for timer management |
| `computeTickInterval()` with various configs | Low | Mixed hold times, no peers, etc. |
| Port exhaustion during `commit()` | Medium | Graceful degradation untested at RIB level |
| `InternalProtocolConnected` full sync propagation | Medium | Distinct code path from `InternalProtocolOpen` |
| `commit()` with stale plan | Low | What happens if state changed between plan and commit? |
| Unknown action type default branch | Low | Logs warning, returns success — untested |
| LocalPeerDelete egress port release | High | See H3 — no test with Envoy enabled |
| Tick-based expiry egress port release | High | See H4 — no test with Envoy enabled |

---

## Architecture Diagram (Final State)

```
orchestrator.ts (thin shell — ~400 lines)
  ├── ActionQueue (serialization — 34 lines)
  ├── RoutingInformationBase (state machine — 774 lines)
  │   ├── plan() → PlanResult (pure, synchronous)
  │   └── commit(plan) → CommitResult (side-effectful)
  ├── PeerTransport (fan-out — 105 lines)
  │   ├── sendUpdate / sendOpen / sendClose
  │   └── sendKeepalive (⚠ no-op)
  └── ConnectionPool (RPC stub cache — 40 lines)
      └── ⚠ imports PublicApi from orchestrator.ts (circular)
```

**Dependency Flow**:
- `orchestrator → action-queue, rib, peer-transport, connection-pool` ✓
- `peer-transport → connection-pool` ✓
- `rib → peer-transport` (type-only for `Propagation`) — acceptable
- `connection-pool → orchestrator` (type-only for `PublicApi`) — **violation** (B3)

---

## Issue Summary

| Severity | Count | Key Issues |
|----------|-------|------------|
| **Blocker** | 3 | Keepalive no-op, holdTime=0, circular dep |
| **High** | 6 | Fire-and-forget propagation, no RPC timeout, port leaks (×2), stale plan, port semantics |
| **Medium** | 11 | Dead types, @ts-expect-error, tick interval static, no backpressure, port failure swallowed, flaky timing, mutable state ref, test helper duplication, conditional assertions, synthetic plans, tie-breaking |
| **Low** | 10 | Various nits and documentation gaps |

---

## Detailed Validation and Fix Options (2026-02-19)

Each issue below was re-validated against the current branch contents before writing this addendum.

### B1. `sendKeepalive()` is a no-op — remote peers will always expire

**Findings**
- Confirmed in `apps/orchestrator/src/peer-transport.ts:82` that `sendKeepalive()` does not call any RPC method.
- Confirmed in `apps/orchestrator/src/rib.ts:116` that keepalive propagations still advance `lastSent`, creating false local liveness.
- Confirmed in `apps/orchestrator/src/peer-transport.ts:12` that keepalive propagation lacks `localNode`, so it cannot call `update(peerInfo, update)` without reshaping.

**Potential fixes**
1. Add `localNode` to keepalive propagation and implement keepalive as `update(localNode, { updates: [] })`.
2. Remove the keepalive propagation variant and emit a normal `update` propagation with an empty payload instead.
3. Keep keepalive as no-op for now, but stop updating `lastSent` for keepalive propagations.

**Recommendation**
- Use option 2. It removes special-case transport logic and guarantees keepalive actually traverses the wire.

**Stack insertion point**
- Preferred: amend PR #359 (PR 7). If immutable, insert a fix PR immediately after PR 7 and before PR 8.

### B2. `holdTime=0` causes immediate peer expiry instead of "never expire"

**Findings**
- Confirmed expiry check in `apps/orchestrator/src/rib.ts:471` only gates on `holdTime != null`; zero is treated as an immediate threshold.
- Confirmed keepalive scheduling in `apps/orchestrator/src/rib.ts:699` has the same zero-value behavior.
- Confirmed tests currently document this as current behavior in `apps/orchestrator/tests/bgp-hold-timer-edge-cases.test.ts:78`.

**Potential fixes**
1. Add `peer.holdTime > 0` to both expiry and keepalive conditions.
2. Normalize `holdTime=0` to `undefined` at peer ingest/update and keep existing timer code unchanged.
3. Add an explicit `disableHoldTimer` boolean and reject ambiguous `holdTime=0`.

**Recommendation**
- Use option 1 now (smallest change, RFC-aligned), and optionally add option 2 later to simplify timer code.

**Stack insertion point**
- Preferred: amend PR #359 (PR 7). If immutable, insert a fix PR immediately after PR 7 and before PR 8.

### B3. Circular dependency: `connection-pool.ts` ↔ `orchestrator.ts`

**Findings**
- Confirmed `apps/orchestrator/src/connection-pool.ts:7` imports `PublicApi` from `orchestrator.ts`, while `orchestrator.ts` imports `ConnectionPool`.
- It is type-only at runtime, but it still inverts intended layer boundaries.

**Potential fixes**
1. Extract `PublicApi`, `NetworkClient`, `DataChannel`, and `IBGPClient` into `apps/orchestrator/src/api-types.ts`.
2. Make `ConnectionPool` generic (`ConnectionPool<TApi>`) and bind concrete API types at call sites.
3. Create dedicated typed pool wrappers (`PeerPool`, `EnvoyPool`, `GatewayPool`) so base pool is transport-only.

**Recommendation**
- Use option 1 immediately, then option 2 in a follow-up if you want stronger typing flexibility.

**Stack insertion point**
- Preferred: amend PR #355 (PR 3). If immutable, insert a fix PR immediately after PR 3 and before PR 4.

### H1. `handlePostCommit` is fire-and-forget with no error surfacing

**Findings**
- Confirmed `apps/orchestrator/src/orchestrator.ts:252` assigns `lastNotificationPromise` and returns success immediately from `dispatch`.
- Failures are logged, not surfaced to caller; there is no retry/reconcile path.
- Additional correctness gap: `LocalPeerCreate` success path checks only promise fulfillment, not `open()` RPC result (`apps/orchestrator/src/orchestrator.ts:263` plus `apps/orchestrator/src/peer-transport.ts:59`).

**Potential fixes**
1. Await `handlePostCommit()` in `pipeline()` and include post-commit result in `DispatchResult`.
2. Keep async behavior but extend `DispatchResult` with `postCommitAccepted: true` plus a status token for later retrieval.
3. Keep current API and add periodic reconciliation on `Tick` that re-syncs routes/peers and retries failed fan-out.

**Recommendation**
- Use option 2 plus option 3. This preserves throughput while making failure state observable and recoverable.

**Stack insertion point**
- Preferred: amend PR #358 (PR 6). If immutable, insert a fix PR immediately after PR 6 and before PR 7.

### H2. No timeout on RPC calls in `PeerTransport`

**Findings**
- Confirmed unbounded awaits in `apps/orchestrator/src/peer-transport.ts:42`, `:47`, `:59`, and `:79`.
- `Promise.allSettled` isolates peers but does not bound total post-commit latency if a call never resolves.

**Potential fixes**
1. Wrap each RPC await in a `withTimeout()` helper using `Promise.race`.
2. Add AbortSignal-aware RPC calls and pass `AbortSignal.timeout(ms)` through capnweb clients.
3. Bound fan-out with per-peer timeout and emit structured timeout errors to metrics/logging.

**Recommendation**
- Use option 1 now because it is local and low-risk; move to option 2 if capnweb supports cancellation primitives.

**Stack insertion point**
- Preferred: amend PR #355 (PR 3). If immutable, insert a fix PR immediately after PR 3 and before PR 4.

### H3. `LocalPeerDelete` does not release egress ports — port leak

**Findings**
- Confirmed `apps/orchestrator/src/rib.ts:206` route actions omit `Actions.LocalPeerDelete`.
- `LocalPeerDelete` removes internal routes (`apps/orchestrator/src/rib.ts:328`) but no release ops are generated.

**Potential fixes**
1. Add `Actions.LocalPeerDelete` to route actions and release `egress_${route.name}_via_${route.peerName}` for removed peer routes.
2. Replace action allow-list logic with state-diff logic: release all ports present in prev-state but absent in new-state.
3. Add explicit `computePeerDeletePortOps()` branch called from `computePortOps`.

**Recommendation**
- Use option 2. It fixes this bug and prevents future omissions on new actions.

**Stack insertion point**
- Preferred: amend PR #370 (PR 10). If immutable, insert a fix PR immediately after PR 10 and before PR 11.

### H4. Tick-based peer expiry also does not release egress ports

**Findings**
- Confirmed `Actions.Tick` is omitted from `apps/orchestrator/src/rib.ts:206` route action allow-list.
- Expired peers/routes are removed (`apps/orchestrator/src/rib.ts:481`) without corresponding release ops.

**Potential fixes**
1. Add `Actions.Tick` to route actions and release egress keys for expired-peer routes.
2. Apply the same prev/new diff-based port release approach described in H3.
3. Move port release to a post-state “garbage collect orphaned allocations” pass.

**Recommendation**
- Use option 2 to solve both H3 and H4 with one robust mechanism.

**Stack insertion point**
- Preferred: amend PR #370 (PR 10). If immutable, insert the fix PR directly after the H3 fix and before PR 11.

### H5. `commit()` does not validate plan staleness

**Findings**
- Confirmed `apps/orchestrator/src/rib.ts:103` lacks guard that `plan.prevState === this.state`.
- Synthetic plan injection in tests (for example `apps/orchestrator/tests/keepalive.test.ts:63`) demonstrates this surface is actively used.

**Potential fixes**
1. Add hard guard in `commit()` and throw on stale plan.
2. Change `commit()` to return `PlanFailure` when stale instead of throwing.
3. Make `commit()` private/internal and expose `apply(action)` as the public mutation API.

**Recommendation**
- Use option 1 and add a test-only helper for explicit state mutation to replace synthetic stale-plan patterns.

**Stack insertion point**
- Preferred: amend PR #370 (PR 10). If immutable, insert a fix PR immediately after PR 10 and before PR 11.

### H6. `stampPortsOnState` semantics may confuse state consumers

**Findings**
- Confirmed internal route `envoyPort` can represent remote-advertised port or local egress allocation depending on path (`apps/orchestrator/src/rib.ts:186`, `:516`, `:654`).
- This mixed semantic is not encoded in type names and can mislead direct `getState()` consumers.

**Potential fixes**
1. Add explicit `remoteEnvoyPort` and `localEgressPort` fields, keeping `envoyPort` deprecated.
2. Keep state as pure remote view and compute local egress ports only in sync payloads.
3. Normalize state to always store local egress ports and move remote port to metadata only.

**Recommendation**
- Use option 1. It is explicit and least surprising for future consumers.

**Stack insertion point**
- Preferred: amend PR #370 (PR 10). If immutable, insert a fix PR immediately after PR 10 and before PR 11.

### M1. Dead types in `types.ts`

**Findings**
- Confirmed `StateResult` and `NotificationResult` are declared in `apps/orchestrator/src/types.ts:26` and unused elsewhere.

**Potential fixes**
1. Delete both exports.
2. Keep them with `@deprecated` JSDoc and remove in the next major version.

**Recommendation**
- Use option 1 unless there is an external consumer depending on these types.

**Stack insertion point**
- Preferred: amend PR #358 (PR 6). If immutable, insert a cleanup PR immediately after PR 6 and before PR 7.

### M2. `@ts-expect-error` for Envoy and Gateway RPC stubs

**Findings**
- Confirmed suppressions at `apps/orchestrator/src/orchestrator.ts:294` and `:327`.
- Root cause is `ConnectionPool` fixed typing to `PublicApi` (`apps/orchestrator/src/connection-pool.ts:18`) while used for multiple RPC APIs.

**Potential fixes**
1. Split pools by API type (`ConnectionPool<PublicApi>`, `ConnectionPool<EnvoyApi>`, `ConnectionPool<GatewayApi>`).
2. Add endpoint-to-API typed wrappers (`getEnvoyStub()`, `getGatewayStub()`) around a lower-level pool.
3. Change pool map value type to a discriminated union and narrow before calls.

**Recommendation**
- Use option 2 for best readability at call sites with minimal API churn.

**Stack insertion point**
- Preferred: amend PR #355 (PR 3) together with B3. If immutable, place a fix PR after PR 3 and before PR 4.

### M3. Tick interval computed once at startup, never updated

**Findings**
- Confirmed `startTick()` computes interval once (`apps/orchestrator/src/orchestrator.ts:166`) and no later recomputation occurs.
- New peers or hold-time changes can make interval stale.

**Potential fixes**
1. Recompute and restart timer on peer create/update/open/connected/delete actions.
2. Switch from `setInterval` to self-scheduling `setTimeout` that recalculates before each run.
3. Use a fixed conservative interval (for example 1s) independent of peer state.

**Recommendation**
- Use option 2; it also helps resolve M4 cleanly.

**Stack insertion point**
- Preferred: amend PR #359 (PR 7). If immutable, insert a fix PR immediately after PR 7 and before PR 8.

### M4. No tick dispatch backpressure

**Findings**
- Confirmed `setInterval` in `apps/orchestrator/src/orchestrator.ts:168` dispatches regardless of prior tick completion.
- Under load this can enqueue unbounded `Tick` actions.

**Potential fixes**
1. Add `tickInFlight` guard and skip overlap.
2. Use recursive `setTimeout` only after tick completion.
3. Add ActionQueue-level dedupe for `Tick` actions when one is queued/in-flight.

**Recommendation**
- Use option 2 plus optional option 3 for additional queue protection.

**Stack insertion point**
- Preferred: amend PR #359 (PR 7). If immutable, insert a fix PR immediately after PR 7 and before PR 8.

### M5. Port allocation failure silently swallowed in `commit()`

**Findings**
- Confirmed `executePortOps()` logs allocation failure and continues (`apps/orchestrator/src/rib.ts:159-162`).
- This allows route state to advance with missing port mapping.

**Potential fixes**
1. Make allocation failure abort commit and return/throw error.
2. Keep commit but annotate route/metadata as degraded and prevent envoy sync for degraded entries.
3. Add retry queue for failed allocations and avoid stamping until success.

**Recommendation**
- Use option 1 for strict correctness, then add option 2 only if partial availability is required.

**Stack insertion point**
- Preferred: amend PR #370 (PR 10). If immutable, insert a fix PR immediately after PR 10 and before PR 11.

### M6. Tests use `setTimeout` for propagation timing

**Findings**
- Confirmed timing sleeps in `apps/orchestrator/tests/orchestrator.topology.test.ts:90` and many other topology/container tests.
- Some tests already use `lastNotificationPromise`, so deterministic synchronization pattern exists but is not consistently applied.

**Potential fixes**
1. Standardize on awaiting `lastNotificationPromise` (or equivalent) in all non-container tests.
2. Add explicit `await bus.drain()` test helper API that waits queue + post-commit completion.
3. Use fake timers for unit-level tests to eliminate wall-clock sleeps.

**Recommendation**
- Use option 2 as the primary synchronization API, with option 1 as immediate cleanup.

**Stack insertion point**
- Preferred: add as a dedicated test-hardening PR after PR #381 (PR 21) and before test-reorg PRs (#382-#384).

### M7. `getState()` returns mutable reference to internal state

**Findings**
- Confirmed `apps/orchestrator/src/rib.ts:59` returns `this.state` directly.
- Tests rely on this mutability for synthetic updates, but production callers can also mutate internals.

**Potential fixes**
1. Return `structuredClone(this.state)` from `getState()`.
2. Return readonly/frozen copy in production and expose `unsafeGetStateForTests()` for tests.
3. Enforce immutability with persistent data structures and readonly types throughout.

**Recommendation**
- Use option 2 for minimal runtime overhead while preserving test flexibility.

**Stack insertion point**
- Preferred: amend PR #357 (PR 5). If immutable, insert a fix PR immediately after PR 5 and before PR 6.

### M8. ~700 lines of duplicated test helpers across 23+ files

**Findings**
- Confirmed repeated helper declarations with near-identical bodies across many files (for example `createRib`, `planCommit`, `connectPeer`).

**Potential fixes**
1. Extract `apps/orchestrator/tests/rib-test-helpers.ts` and shared fixtures/constants.
2. Build a test fixture factory (`createRibFixture`) that returns helpers and canonical peer constants.
3. Use a local test utility package under `apps/orchestrator/tests/utils`.

**Recommendation**
- Use option 1 now; migrate to option 2 only if helper complexity keeps growing.

**Stack insertion point**
- Preferred: fold into test reorganization PRs #382-#384 (PRs 22-24), ideally as one squashed reorg PR.

### M9. Conditional assertion anti-pattern in multiple test files

**Findings**
- Confirmed repeated pattern `expect(x).toBeDefined(); if (x && x.type === 'update') { ... }`, which can silently skip assertions.
- Example: `apps/orchestrator/tests/bgp-propagation-correctness.test.ts:230`.

**Potential fixes**
1. Use non-null assertion after existence check (`const u = toC as Extract<...>`).
2. Introduce helper `assertUpdatePropagation(p): asserts p is ...` and call it before assertions.
3. Replace with `expect(...).toSatisfy(...)` style predicates plus direct extraction.

**Recommendation**
- Use option 2 to improve both safety and readability across all affected files.

**Stack insertion point**
- Preferred: add as a dedicated test-cleanup PR after PR #381 (PR 21) and before PRs #382-#384.

### M10. `setPeerTimingFields` fabricates synthetic plans bypassing pipeline

**Findings**
- Confirmed helper constructs manual plan objects and calls `commit()` directly (for example `apps/orchestrator/tests/keepalive.test.ts:63`).
- This bypasses stale-plan validation and can desynchronize metadata (`routeMetadata: new Map()`).

**Potential fixes**
1. Add explicit test-only method on RIB to set peer timing fields.
2. Inject a clock dependency and drive timing by advancing fake/system time through real actions.
3. Add internal helper action (for tests only) behind compile-time guard.

**Recommendation**
- Use option 2 for best long-term architecture; use option 1 as an interim migration step.

**Stack insertion point**
- Preferred: split across PR #359 (PR 7, clock/testability hooks) and keepalive tests in PR #377 (PR 18). If immutable, insert one fix PR after PR 18 and before PR 19.

### M11. Best-path tie-breaking test doesn't verify determinism

**Findings**
- Confirmed test name claims deterministic tie-breaking, but assertion only checks winner is in `{B,C}` (`apps/orchestrator/tests/bgp-best-path-selection.test.ts:80`).
- Production comparator in `apps/orchestrator/src/rib.ts:761` uses path length only and depends on stable sort/insertion order.

**Potential fixes**
1. Add deterministic secondary comparator (`peerName.localeCompare`) in production.
2. Preserve deterministic insertion rank and tie-break by rank explicitly.
3. Update test to run repeated permutations and assert same winner each time.

**Recommendation**
- Use option 1 and option 3 together.

**Stack insertion point**
- Preferred: amend PR #360 (PR 8) for production comparator, then align tests in the first best-path test PR in the #372-#381 range.

### L1. `Propagation` type imported into RIB from peer-transport

**Findings**
- Confirmed `apps/orchestrator/src/rib.ts:12` imports `Propagation` from `peer-transport.ts`.

**Potential fixes**
1. Move `Propagation` to `apps/orchestrator/src/api-types.ts` or `propagation.ts`.
2. Define propagation contracts in `rib.ts` and make transport consume that type.

**Recommendation**
- Use option 1 alongside B3 type extraction.

**Stack insertion point**
- Preferred: amend PR #355 (PR 3). If immutable, include in the same follow-up PR as B3/M2 right after PR 3.

### L2. `import type { z } from 'zod'` in orchestrator/peer-transport

**Findings**
- Confirmed `apps/orchestrator/src/orchestrator.ts:1` and `apps/orchestrator/src/peer-transport.ts:1` use `z.infer` solely for type inference.

**Potential fixes**
1. Export concrete update-message type from `@catalyst/routing` and import that type directly.
2. Create local type alias module that centralizes `z.infer` once.

**Recommendation**
- Use option 1 to remove zod coupling from consumers.

**Stack insertion point**
- Preferred: amend PR #355 (PR 3). If immutable, include in the same follow-up PR as B3/L1 after PR 3.

### L3. `ConnectionPool` constructor defaults inconsistent

**Findings**
- Confirmed nested ternary at `apps/orchestrator/src/orchestrator.ts:128-132` is harder to parse than equivalent branching.

**Potential fixes**
1. Replace with explicit `if/else` assignment.
2. Extract pool creation into a `createConnectionPool(opts.connectionPool)` helper.

**Recommendation**
- Use option 1 unless pool creation logic is expected to grow.

**Stack insertion point**
- Preferred: amend PR #358 (PR 6). If immutable, insert cleanup PR right after PR 6.

### L4. `DataChannelDefinitionSchema` re-exported as `ServiceDefinitionSchema`

**Findings**
- Confirmed alias in `apps/orchestrator/src/index.ts:8` has no deprecation annotation or docs context.

**Potential fixes**
1. Document alias intent and timeline in `apps/orchestrator/README.md`.
2. Mark alias as deprecated in code comments/JSDoc and remove in next major.
3. Remove alias immediately and update downstream imports.

**Recommendation**
- Use option 2 (deprecate + document), then remove on next major.

**Stack insertion point**
- Preferred: documentation/deprecation in PR #371 (PR 11). If immutable, add a docs-only follow-up after PR 11.

### L5. README tie-breaking docs slightly imprecise

**Findings**
- Could not reproduce in current repository: tie-breaking language cited in this issue is not present in `README.md` or `apps/orchestrator/README.md`.
- This appears stale or path-misreferenced in the original review notes.

**Potential fixes**
1. Mark this issue resolved/stale and remove it from active issue count.
2. Add an explicit tie-breaking section to `apps/orchestrator/README.md` anyway for clarity.

**Recommendation**
- Use option 1 now; optionally do option 2 as documentation hardening.

**Stack insertion point**
- If kept, place this in PR #371 (PR 11). If treated as stale (recommended), remove from active stack work and do not add a new PR.

### L6. `Math.min(...holdTimes)` stack overflow with large arrays

**Findings**
- Confirmed spread usage in `apps/orchestrator/src/orchestrator.ts:190`.

**Potential fixes**
1. Replace with `holdTimes.reduce((min, t) => Math.min(min, t), Infinity)`.
2. Use manual loop to compute minimum without spread.

**Recommendation**
- Use option 1 for succinctness and safety.

**Stack insertion point**
- Preferred: amend PR #359 (PR 7). If immutable, add a small follow-up directly after PR 7.

### L7. `stopTick()` never called from lifecycle hook

**Findings**
- Confirmed `stopTick()` exists (`apps/orchestrator/src/orchestrator.ts:175`) but is not called from `OrchestratorService.onShutdown()` (`apps/orchestrator/src/service.ts:106`).

**Potential fixes**
1. Call `this._bus.stopTick()` in `onShutdown()`.
2. Add explicit bus lifecycle method (`shutdown()`) that clears timers/resources and call it from service shutdown.

**Recommendation**
- Use option 2 for lifecycle hygiene; include option 1 immediately as a quick patch.

**Stack insertion point**
- Preferred: amend PR #359 (PR 7) because it introduced ticking; if immutable, insert a follow-up right after PR 7.

### L8. Test catalog count "206 tests" will drift

**Findings**
- Confirmed hard-coded count at `apps/orchestrator/tests/TEST-CATALOG.md:5`.

**Potential fixes**
1. Generate the count via script in CI and update the file automatically.
2. Replace exact count with non-numeric wording (for example, "see test output for current totals").

**Recommendation**
- Use option 1 if you want a stable catalog; otherwise option 2 to avoid maintenance churn.

**Stack insertion point**
- Preferred: amend PR #389 (PR 28). If immutable, add docs follow-up immediately after PR 28.

### L9. Type cast `as Plan` used instead of type narrowing in tests

**Findings**
- Confirmed widespread `as Plan` casts in tests (for example `apps/orchestrator/tests/keepalive.test.ts:90`).

**Potential fixes**
1. Replace casts with `if (!plan.success) throw` narrowing before commit/assertions.
2. Add helper `assertPlanSuccess(plan): Plan` and use it across tests.

**Recommendation**
- Use option 2 to keep tests concise while preserving type safety.

**Stack insertion point**
- Preferred: add as a dedicated test-cleanup PR after PR #381 (PR 21) and before PRs #382-#384.

### L10. No test for unknown action type default branch

**Findings**
- Confirmed default branch logs warning and returns success in `apps/orchestrator/src/rib.ts:493`.
- No tests currently target this branch.

**Potential fixes**
1. Add explicit unit test injecting unknown action via cast and assert warning + unchanged state.
2. Change default branch behavior to return failure and update tests/API expectations.

**Recommendation**
- Use option 1 immediately; decide on option 2 only if unknown actions are expected from untrusted callers.

**Stack insertion point**
- Preferred: add to PR #388 (PR 27, coverage tests). If immutable, add a tiny test follow-up right after PR 27 and before PR 28.

---

## Questions for the Author

1. Is `sendKeepalive` intentionally a no-op for this stack, or is it an oversight? The hold timer / keepalive interval logic is complete but the transport stub doesn't send anything.

2. Is `holdTime=0` intentionally "immediate expiry" or should it follow RFC 4271 "never expire" semantics?

3. Should `PublicApi` be extracted from `orchestrator.ts` to break the circular dependency?

4. Should `handlePostCommit` propagation failures be surfaced in `DispatchResult`?

5. Should `stopTick()` be called from `OrchestratorService.onShutdown()`?

6. Is there a plan to extract the duplicated test helpers into a shared module?

7. Should the port leak for `LocalPeerDelete` and `Tick`-based expiry be addressed in this stack?
