# BGP Hardening: Graceful Shutdown & Peer Session Flap Detection

**Date:** 2026-04-06
**Issues:** [#404](https://github.com/orbisoperations/catalyst-router/issues/404), [#408](https://github.com/orbisoperations/catalyst-router/issues/408)
**Status:** Draft
**Stacks on:** [#652](https://github.com/orbisoperations/catalyst-router/pull/652) (flap damping)
**References:** [RFC 8326](https://www.rfc-editor.org/rfc/rfc8326.html), [RFC 4271 §8](https://www.rfc-editor.org/rfc/rfc4271.html#section-8), [BIRD User's Guide — BGP error timers](https://bird.network.cz/doc/bird-6.html), [NLNOG BGP Filter Guide — Graceful Shutdown](https://bgpfilterguide.nlnog.net/guides/graceful_shutdown/)

## Problem

Two session-level safety gaps remain:

1. **No graceful shutdown.** When a node stops, routes are withdrawn immediately and peers lose all paths through that node. During rolling deploys this causes traffic disruption even when alternative paths exist.
2. **No session flap detection.** A peer with an unstable connection reconnects repeatedly, triggering a full route sync on every reconnect. This floods the mesh with redundant propagation.

## Scope

Two independent features in one spec:

- **Graceful shutdown with drain signal** (GitHub [#404](https://github.com/orbisoperations/catalyst-router/issues/404)) — deprioritize routes before shutdown so peers shift traffic to alternatives.
- **Peer session flap detection** (GitHub [#408](https://github.com/orbisoperations/catalyst-router/issues/408)) — exponential backoff on reconnect to prevent full-sync storms.

---

## Feature 1: Graceful Shutdown

### Design Rationale

[RFC 8326](https://www.rfc-editor.org/rfc/rfc8326.html) defines graceful shutdown via a well-known BGP community (65535:0) that reduces LOCAL_PREF to 0. Since our protocol has neither communities nor LOCAL_PREF, we adapt the same principle: a `draining` flag on routes that causes receivers to deprioritize them in best-path selection. The key RFC insight is preserved — **routes stay in the RIB as backup, they're just deprioritized.** Traffic shifts to alternatives before the session goes down.

All major implementations ([FRR](https://docs.frrouting.org/en/latest/bgp.html#graceful-shutdown), [BIRD](https://bgpfilterguide.nlnog.net/guides/graceful_shutdown/#bird), [Juniper](https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/statement/graceful-shutdown-edit-protocols-bgp.html), [OpenBGPD](https://bgpfilterguide.nlnog.net/guides/graceful_shutdown/#openbgpd)) use this same pattern: tag, deprioritize, wait, then shut down.

### Behavior

When `Actions.AdminGracefulShutdown` is dispatched:

1. All local routes are marked `draining: true`
2. Updated routes are propagated to all peers (as `'updated'` changes)
3. Peers deprioritize drained routes in best-path selection — a drained route always loses to a non-drained route regardless of path length

When `Actions.AdminCancelShutdown` is dispatched:

1. All local routes have `draining` cleared
2. Updated routes re-propagated normally

### Type Changes

**`DataChannelDefinition`** (`packages/routing/src/v2/datachannel.ts`):

```typescript
draining?: boolean
```

**New actions** (`packages/routing/src/v2/system/actions.ts` or equivalent):

```typescript
Actions.AdminGracefulShutdown = 'admin:graceful-shutdown'
Actions.AdminCancelShutdown = 'admin:cancel-shutdown'
```

Both take empty data (no payload needed).

### Implementation

**`planAdminGracefulShutdown`** in RIB:

- Set `draining: true` on every local route
- Return routeChanges as `'updated'` for each

**`planAdminCancelShutdown`** in RIB:

- Set `draining: false` (or delete the field) on every local route
- Return routeChanges as `'updated'` for each

**Best-path selection** in `planInternalProtocolUpdate`:

- Current logic: prefer shorter `nodePath.length`, or replace stale routes
- Add: a non-drained route always beats a drained route, regardless of path length

**Propagation:** No changes needed — `buildUpdatesForPeer` already propagates `'updated'` routeChanges. The `draining` field flows through `BusTransforms.toDataChannel`.

### Tests (5)

1. Shutdown marks all local routes as draining
2. Drained routes propagated to peers with drain flag
3. Peers deprioritize drained routes — non-drained route from another peer wins even if longer path
4. Cancel removes drain marker, routes re-propagated normally
5. Topology (A→C, B→C): A drains, C switches to B's route. A cancels, C switches back to A (shorter path)

---

## Feature 2: Peer Session Flap Detection

### Design Rationale

[RFC 4271 §8](https://www.rfc-editor.org/rfc/rfc4271.html#section-8) defines optional `DampPeerOscillations` FSM behavior using an `IdleHoldTimer` with exponential backoff. No real implementation uses a penalty-counter system for sessions — they all use **reconnect delay backoff**:

- [BIRD](https://bird.network.cz/doc/bird-6.html): `error wait time` exponentially increases from 60s to 300s. `error forget time` (300s) resets after stability.
- [FRR](https://docs.frrouting.org/en/latest/bgp.html): Connect retry timer (120s default, 10s in datacenter mode).
- [Huawei](https://www.juniper.net/documentation/us/en/software/junos/bgp/topics/topic-map/bgp-session-flaps.html): Explicit `peer oscillation-dampening` with step-wise backoff up to 600s.

We follow BIRD's model — simplest and best documented.

### Behavior

Track `consecutiveFailures` on each peer. On reconnect, defer the initial full route sync by an exponentially increasing delay. Reset after a stability period.

### Constants

```typescript
const SESSION_FLAP_BASE_DELAY_MS = 5_000 // 5 seconds initial delay
const SESSION_FLAP_MAX_DELAY_MS = 300_000 // 5 minutes cap (BIRD default)
const SESSION_FLAP_STABILITY_MS = 300_000 // 5 minutes stable = reset (BIRD's error forget time)
```

### Type Changes

**`PeerRecord`** (`packages/routing/src/v2/state.ts`):

```typescript
consecutiveFailures?: number   // default 0
lastFailure?: number           // epoch ms of last disconnect
```

### Implementation

**On `planInternalProtocolClose`:**

- Increment `consecutiveFailures` on the peer
- Set `lastFailure = Date.now()`

**On `planInternalProtocolConnected`:**

- If `consecutiveFailures > 0`, calculate delay: `Math.min(BASE_DELAY * 2^(failures-1), MAX_DELAY)`
- Store `syncDeferredUntil` on the peer record so `handlePostCommit` can check it

**In `handlePostCommit` (bus.ts):**

- On `InternalProtocolConnected`: check `peer.syncDeferredUntil`. If `now < syncDeferredUntil`, skip the initial full sync. The sync will happen on the next Tick that finds the peer connected with a pending deferred sync.

**On `planTick`:**

- For peers where `consecutiveFailures > 0` and `lastFailure` is older than `SESSION_FLAP_STABILITY_MS`: reset `consecutiveFailures` to 0
- For peers with `syncDeferredUntil` in the past: clear the flag (triggers sync on next post-commit)

### Tests (5)

1. First disconnect/reconnect: `consecutiveFailures = 1`, sync delay = 5s
2. Third consecutive reconnect: delay = 20s (5000 \* 2^2)
3. Delay capped at MAX_DELAY (300s) after many failures
4. Stable for 5 minutes (via Tick): `consecutiveFailures` resets to 0
5. Non-flapping peer (first connect, no failures): immediate full sync, no delay

---

## Interaction Between Features

Independent. Graceful shutdown changes route state (local routes). Session flap detection changes peer connection behavior. A node could be both draining AND have a flapping peer — both mechanisms operate correctly.

## Files Changed

| File                                                   | Changes                                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/routing/src/v2/datachannel.ts`               | Add `draining?: boolean` to DataChannelDefinition                                                                                       |
| `packages/routing/src/v2/state.ts`                     | Add `consecutiveFailures?`, `lastFailure?`, `syncDeferredUntil?` to PeerRecord                                                          |
| `packages/routing/src/v2/action-types.ts`              | Add `AdminGracefulShutdown`, `AdminCancelShutdown`                                                                                      |
| `packages/routing/src/v2/rib/rib.ts`                   | New plan handlers for shutdown/cancel, drain deprioritization in best-path, failure counter in close/connected, stability reset in Tick |
| `apps/orchestrator/src/v2/bus.ts`                      | Deferred sync check in handlePostCommit                                                                                                 |
| `apps/orchestrator/tests/v2/graceful-shutdown.test.ts` | 5 unit + topology tests                                                                                                                 |
| `apps/orchestrator/tests/v2/session-flap.test.ts`      | 5 unit tests                                                                                                                            |
