# V1 → V2 Orchestrator Gap Analysis

**Date:** 2026-03-10
**Scope:** One-directional — v1 capabilities missing or degraded in v2.
**Method:** Both capability catalogs read in full; every gap spot-checked against actual source code.

---

## GAP-001

**Category:** Connection Management
**Severity:** Critical
**Effort:** M (1–2 days)

### v1 Capability

On `LocalPeerCreate`, v1 immediately attempts an outbound connection to the peer:

```
// apps/orchestrator/src/v1/orchestrator.ts:525–553 (handleBGPNotify)
case Actions.LocalPeerCreate: {
  // connectionPool.get(endpoint) → getIBGPClient(peerToken) → open(localNode)
  // On success → dispatch(InternalProtocolConnected)
  // On failure → log error, leave peer as 'initializing'
}
```

This means the iBGP session is established automatically the moment a peer is configured. No external actor is needed to trigger the connection.

### v2 Status

v2 defines a `ReconnectManager` with `scheduleReconnect(peer)`, and the `WebSocketPeerTransport` has `openPeer(peer, token)`. However, **neither is invoked by the bus on `LocalPeerCreate`**. The bus handler for `LocalPeerCreate` only mutates state (adds peer record with `connectionStatus='initializing'`).

There is no code path in `OrchestratorBus` or `OrchestratorServiceV2` that calls `transport.openPeer()` or `reconnectManager.scheduleReconnect()` after a `LocalPeerCreate` is committed.

**Code references:**
- `apps/orchestrator/src/v2/bus.ts` — no `LocalPeerCreate` case in `handleBGPNotify` / `handlePostCommit`
- `apps/orchestrator/src/v2/service.ts:105–113` — wraps dispatch to recalculate tick on peer events, but never calls `reconnectManager.scheduleReconnect()`

### Notes

This is the most critical gap. Without it, v2 is architecturally incomplete as a drop-in replacement — adding a peer does nothing to establish the session. External callers (CLI, SDK) would need to know to call into `reconnectManager` directly after `addPeer()`, which is not part of the RPC contract.

The fix is to call `reconnectManager.scheduleReconnect(peer)` (or `transport.openPeer()`) inside the dispatch wrapper in `OrchestratorServiceV2` after a successful `LocalPeerCreate`. This also needs to handle `LocalPeerUpdate` (endpoint change might require reconnection).

---

## GAP-002

**Category:** BGP Protocol — Initial Sync
**Severity:** Critical
**Effort:** S (hours)

### v1 Capability

v1 performs a full-table route sync on **both**:

1. `InternalProtocolOpen` — when a **remote** peer calls `open()` on this node (inbound connection). The responder sends all known routes back to the initiator.
2. `InternalProtocolConnected` — when the **local** node successfully opens a connection to a peer (outbound connection success).

```
// apps/orchestrator/src/v1/orchestrator.ts:556–661
case Actions.InternalProtocolOpen: { /* syncAllRoutes back to caller */ }
case Actions.InternalProtocolConnected: { /* syncAllRoutes to newly connected peer */ }
```

This ensures both sides exchange their full route tables when a session is established, regardless of which side initiated.

### v2 Status

v2 **only** syncs on `InternalProtocolConnected`:

```
// apps/orchestrator/src/v2/bus.ts:170–177
if (action.action === Actions.InternalProtocolConnected) {
  await this.syncRoutesToPeer(peer, state)
  return
}
```

There is no sync triggered by `InternalProtocolOpen`. When a remote peer connects inbound (calls `open()` on this node), the node transitions to `connected` but never sends its local routes back.

**Result:** In a bidirectional peering scenario (both nodes boot at the same time or one reconnects), only the node that dials out gets a full table sync. The inbound-accepting side will have an empty view of the other node's routes until a delta change arrives.

### Notes

v1 uses `InternalProtocolOpen` as the inbound-accepted trigger and `InternalProtocolConnected` as the outbound-succeeded trigger. They cover complementary cases. v2 needs to add an `InternalProtocolOpen` branch in `handleBGPNotify` that calls `syncRoutesToPeer`.

---

## GAP-003

**Category:** Connection Management — Peer Close Side Effect
**Severity:** Critical
**Effort:** S (hours)

### v1 Capability

On `LocalPeerDelete`, v1 sends a `close()` RPC to the remote peer before removing it:

```
// apps/orchestrator/src/v1/orchestrator.ts:663–686
case Actions.LocalPeerDelete: {
  // 1. close() RPC to remote peer
  // 2. propagateWithdrawalsForPeer()
}
```

This provides a graceful disconnect notification so the remote side can immediately release routes and update connection state, rather than waiting for hold-timer expiry.

### v2 Status

The v2 bus has no `handleBGPNotify` case for `LocalPeerDelete`. After the state is committed (peer removed, routes cleared, withdrawals propagated), no close RPC is sent to the remote peer. The `WebSocketPeerTransport.closePeer()` method exists but is never called from the bus.

**Code reference:** `apps/orchestrator/src/v2/bus.ts` — `handleBGPNotify` only handles `InternalProtocolConnected` and route changes.

### Notes

Without this, the remote peer won't know it was removed until hold-timer expiry (up to 90 seconds). This leaves orphan sessions and potentially stale routes on the remote side.

---

## GAP-004

**Category:** State Management — Validation
**Severity:** Important
**Effort:** S (hours)

### v1 Capability

v1 enforces **`peerToken` as mandatory** when creating a peer:

```
// apps/orchestrator/src/v1/orchestrator.ts:276–278
if (!action.data.peerToken) {
  return { success: false, error: 'peerToken is required when creating a peer' }
}
```

Without a `peerToken`, the peer cannot authenticate to the remote node's `getIBGPClient()` and all subsequent operations (open, update, close) silently fail with logged critical errors.

v1 also enforces a **node name format constraint** at construction:

```
// apps/orchestrator/src/v1/orchestrator.ts:173–184
if (!name.endsWith('.somebiz.local.io')) { throw ... }
if (domains.length > 0 && !domains.some(d => name.endsWith(`.${d}`))) { throw ... }
```

### v2 Status

The v2 RIB handler `planLocalPeerCreate` does **not** require `peerToken`:

```
// packages/routing/src/v2/rib/rib.ts:152–171
private planLocalPeerCreate(data: PeerInfo, state: RouteTable): PlanResult {
  const exists = state.internal.peers.some((p) => p.name === data.name)
  if (exists) return noChange(state)
  // No peerToken check
  ...
}
```

A peer without a `peerToken` will be added to state successfully, but `WebSocketPeerTransport.sendUpdate()` and `sendKeepalive()` both throw if `peer.peerToken` is undefined. This produces a runtime error during the first keepalive or route update rather than a clear validation error at creation time.

The node name format constraint (`*.somebiz.local.io`) is also absent from v2. v2's `OrchestratorService.onInitialize()` does not call any `validateNodeConfig()`.

### Notes

The `peerToken` missing-at-creation case is a parity gap. The node name format validation may be intentionally removed (it's environment-specific), but should be explicitly noted as a deliberate change if so.

---

## GAP-005

**Category:** State Management — Validation
**Severity:** Important
**Effort:** S (hours)

### v1 Capability

v1 validates peer existence before `LocalPeerUpdate` and `LocalPeerDelete`, returning an error if the peer is not found:

```
// apps/orchestrator/src/v1/orchestrator.ts:306–310, 332–338
case Actions.LocalPeerUpdate: {
  if (!peer) return { success: false, error: 'Peer not found' }
}
case Actions.LocalPeerDelete: {
  if (!peer) return { success: false, error: 'Peer not found' }
}
```

Similarly, `LocalRouteCreate` fails with `'Route already exists'` and `LocalRouteDelete` fails with `'Route not found'`.

### v2 Status

v2 uses a **no-op / silent-return pattern** for all of these cases via `noChange(state)`:

```
// packages/routing/src/v2/rib/rib.ts:175, 199
private planLocalPeerUpdate(...): PlanResult {
  if (idx === -1) return noChange(state)  // no error
}
private planLocalPeerDelete(...): PlanResult {
  if (peers.length === state.internal.peers.length) return noChange(state)  // no error
}
```

The dispatch result is `{ success: false, error: 'No state change' }` — a generic, non-descriptive error. RPC callers cannot distinguish "peer not found" from "no-op update" or any other no-state-change case.

**Affected operations:** `LocalPeerUpdate` (not found), `LocalPeerDelete` (not found), `LocalRouteCreate` (already exists), `LocalRouteDelete` (not found).

### Notes

v2's plan/commit model intentionally returns `noChange` for idempotent cases. But the resulting `{ success: false, error: 'No state change' }` at the dispatch layer is a behavior regression: callers expecting `'Peer not found'` to distinguish between "nothing to do" and "invalid argument" will get misleading feedback. This matters for CLI user-facing messages.

A partial fix could add explicit error messages inside the plan functions without breaking the no-op model, or the bus could translate certain no-state-change cases into informative errors.

---

## GAP-006

**Category:** Auth Integration — Fail-Open vs Fail-Closed
**Severity:** Important
**Effort:** S (hours)

### v1 Capability

When no auth service is configured, v1 **allows all operations** (fail-open):

```
// apps/orchestrator/src/v1/orchestrator.ts:196–198
if (!this.authClient) {
  return { valid: true }  // Allow for testing/development
}
```

This makes v1 easy to run in development without any auth infrastructure.

### v2 Status

When no auth service is configured, v2 **rejects all operations** (fail-closed):

```
// apps/orchestrator/src/v2/catalyst-service.ts:181–185
if (!authClient) {
  return {
    async validateToken() {
      return { valid: false, error: 'Auth not configured' }
    },
  }
}
```

Every RPC call (`addPeer`, `addRoute`, `getIBGPClient`, etc.) returns `{ success: false, error: 'Auth not configured' }` when no auth is configured.

### Notes

This is a deliberate v2 security improvement (fail-closed is the safer default). However it is a **behavioral regression** for any existing integration test or development workflow that omits auth config. It must be called out as a breaking change. The v2 catalog acknowledges this but does not flag it as a gap from v1.

Operators migrating from v1 who previously ran without auth will see all operations fail. A migration note is essential.

---

## GAP-007

**Category:** Configuration Schema
**Severity:** Important
**Effort:** S (hours)

### v1 Capability

v1's `OrchestratorConfigSchema` includes `envoyConfig.envoyAddress` as an optional field:

```
// apps/orchestrator/src/v1/types.ts:16–19
envoyConfig: z.object({
  endpoint: z.string(),
  envoyAddress: z.string().optional(),  // <-- present
  portRange: z.array(PortEntrySchema).min(1)
}).optional()
```

`envoyAddress` represents the externally reachable address of this node's Envoy proxy, passed to downstream peers so they know how to route to this node's services.

The v1 `PeerRecord` also stores `envoyAddress` as a field on each peer, passed along in route metadata.

### v2 Status

v2 reuses v1's `OrchestratorConfigSchema` type from `apps/orchestrator/src/v1/types.ts`, so the `envoyAddress` field is present in the config type. However:

1. The v2 capability catalog (`v2-capabilities.md:1168`) omits `envoyAddress` from the listed config structure.
2. The `packages/routing/src/v2` state and route schemas were inspected and show no `envoyAddress` field on `PeerRecord` or `InternalRoute`.
3. The `envoy-client.ts` internal type includes `peer.envoyAddress` but it is not populated from the RIB state.

v1 uses `envoyAddress` to tell downstream peers where to connect to reach this node's Envoy cluster. If absent in v2's routing state, multi-hop Envoy proxy routing may be broken.

### Notes

This needs verification against the `packages/routing/src/v2/state.ts` schema. If `envoyAddress` was intentionally dropped from the v2 routing state (not just the config), that's a functional regression for multi-organization Envoy routing. **Spot-check required before implementing.**

---

## GAP-008

**Category:** BGP Protocol — Multi-Hop Port Rewriting
**Severity:** Important
**Effort:** M (1–2 days)

### v1 Capability

When forwarding internal routes to downstream peers during initial sync and delta fan-out, v1 **rewrites `envoyPort`** in the outgoing update message to reflect the locally allocated egress port:

```
// apps/orchestrator/src/v1/orchestrator.ts:568–582 (initial sync)
const egressKey = `egress_${r.name}_via_${r.peer.name}`
const localPort = this.portAllocator.getPort(egressKey)
if (localPort) {
  route = { ...r, envoyPort: localPort }
}
```

This is also applied during delta fan-out via `InternalProtocolUpdate` propagation. The purpose: downstream peers must send traffic to this node's Envoy (local egress port), not to the upstream origin node's Envoy port.

### v2 Status

v2's `BusTransforms.toDataChannel()` strips InternalRoute fields and returns the `envoyPort` as-is from the route:

```
// apps/orchestrator/src/v2/bus.ts:432–441
toDataChannel(route): DataChannelDefinition {
  return {
    name: route.name,
    protocol: route.protocol,
    endpoint: route.endpoint,
    region: route.region,
    tags: route.tags,
    envoyPort: route.envoyPort,   // No rewrite
  }
}
```

Neither `syncRoutesToPeer()` nor `buildUpdatesForPeer()` rewrites `envoyPort` before sending.

**Code references:**
- `apps/orchestrator/src/v2/bus.ts:293–337` (`syncRoutesToPeer`)
- `apps/orchestrator/src/v2/bus.ts:371–414` (`buildUpdatesForPeer`)

### Notes

In a single-hop topology (direct peer connections only), this gap is invisible. In a multi-hop topology (A→B→C where A's routes transit through B to reach C), C would receive A's original Envoy port instead of B's egress port. Downstream peers would try to connect to the wrong Envoy endpoint.

The fix requires looking up the allocated egress port from `portAllocator` during route serialization in both `syncRoutesToPeer` and `buildUpdatesForPeer`. This creates a coupling between port allocation and BGP propagation that must be handled carefully to avoid race conditions.

---

## GAP-009

**Category:** State Management — External Routes Field
**Severity:** Minor
**Effort:** S (hours)

### v1 Capability

v1's `RouteTable` includes an `external` field:

```
// packages/routing/src/v1/state.ts:25–50
type RouteTable = {
  local: { routes: DataChannelDefinition[] }
  internal: { peers: PeerRecord[]; routes: InternalRoute[] }
  external: { [key: string]: unknown }   // <-- present
}
```

While v1 does not actively write to `external`, it is part of the public type and any external code that reads the state snapshot may expect this field.

### v2 Status

v2's `RouteTable` omits `external`:

```
// packages/routing/src/v2/state.ts:27–42
type RouteTable = {
  local: { routes: DataChannelDefinition[] }
  internal: { peers: PeerRecord[]; routes: InternalRoute[] }
  // no external field
}
```

The `StateResult` type in v2 returns the v2 `RouteTable`, so callers reading `result.state` will no longer see `external`.

### Notes

Since v1 never populates `external`, this is effectively a structural/typing gap rather than a functional one. However, if any downstream consumer (CLI, SDK, tests) reads `state.external`, it will get `undefined` instead of `{}` in v2. Low risk but worth noting for SDK consumers.

---

## GAP-010

**Category:** Error Handling — Token Minting Failure
**Severity:** Minor
**Effort:** S (hours)

### v1 Capability

v1 token minting on startup has **no retry logic**. A single failure throws immediately, failing service initialization:

```
// apps/orchestrator/src/v1/service.ts:120–152
try {
  // mint token
} catch (error) {
  this.telemetry.logger.error`Failed to mint node token: ${error}`
  throw error  // Service fails to start
}
```

### v2 Status

v2 adds **5 retries with exponential backoff** before failing:

```
// apps/orchestrator/src/v2/catalyst-service.ts:240–285
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  // try to mint
  // on failure: wait 1s, 2s, 4s, 8s, 16s (capped at 30s) before next attempt
}
throw lastError  // Only after all attempts exhausted
```

This is a **v2 improvement over v1**, not a gap. Documented here because the absence of retry in v1 is the baseline: v2 is strictly better.

> **This is not a gap.** Included only for completeness and to confirm the asymmetry was intentional.

---

## GAP-011

**Category:** Logging — Action Dispatch
**Severity:** Minor
**Effort:** S (hours)

### v1 Capability

v1 logs every dispatched action at info level before processing:

```
// apps/orchestrator/src/v1/orchestrator.ts:237–243
this.logger.info`Dispatching action: ${sentAction.action}`
if (sentAction.action === Actions.LocalRouteCreate) {
  this.logger.debug`Route create data: ${JSON.stringify(sentAction.data)}`
}
```

v1 also logs peer connection outcomes, route broadcast counts, gateway sync success/failure, and withdrawal propagation counts explicitly.

### v2 Status

v2 logs are more focused. `OrchestratorBus.dispatch()` has no per-action info log. Logging exists at:
- Transport open success (`ws-transport.ts:83`)
- Reconnect attempts (`reconnect.ts`)
- Token operations (`catalyst-service.ts`)
- iBGP identity mismatches (`rpc.ts`)

Missing: action dispatch audit trail, route broadcast counts, gateway sync success, withdrawal propagation progress.

### Notes

Not a functional gap, but operators monitoring live systems will notice reduced log verbosity. Important for observability parity.

---

## GAP-012

**Category:** Configuration — JWT Journal Path
**Severity:** Minor
**Effort:** S (hours)

### v1 Capability

v1 has no journal (in-memory only, no persistence). This is a known v1 limitation.

### v2 Status

v2 supports a persistent SQLite journal via `journalPath` option:

```
// apps/orchestrator/src/v2/service.ts:54–58
if (opts.journalPath !== undefined) {
  const db = new Database(opts.journalPath)
  this.journal = new SqliteActionLog(db)
}
```

However, **`journalPath` is not wired into `OrchestratorConfigSchema` or environment variable loading**. The comment in `catalyst-service.ts:138–139` explicitly marks this as a TODO:

```
// TODO: add journalPath to OrchestratorConfigSchema for persistent journal
// journalPath: undefined → uses in-memory journal
```

The SQLite journal defaults to in-memory unless someone instantiates `OrchestratorServiceV2` directly with `journalPath`. There is no config schema entry, no env var, and no documentation for enabling it.

### Notes

This is a v2 feature that is half-implemented: the code works but is inaccessible through the normal service configuration path. Not a gap from v1 (v1 has no journal at all), but it is a v2 feature that cannot be used in production without code changes.

---

## Summary Table

| Gap ID | Category | v1 Capability | Severity | Effort | Status in v2 |
|--------|----------|--------------|----------|--------|-------------|
| GAP-001 | Connection Management | Auto-dial on LocalPeerCreate | **Critical** | M | Missing — no outbound dial initiated from bus or service |
| GAP-002 | BGP Protocol | Initial sync on InternalProtocolOpen (inbound) | **Critical** | S | Missing — only Connected path syncs |
| GAP-003 | Connection Management | Close RPC on LocalPeerDelete | **Critical** | S | Missing — no closePeer called |
| GAP-004 | Validation | peerToken required; node name format check | **Important** | S | peerToken: not enforced in RIB; node name check: absent |
| GAP-005 | Validation | Descriptive errors (not found, already exists) | **Important** | S | Generic 'No state change' for all no-op cases |
| GAP-006 | Auth Integration | Fail-open when no auth configured | **Important** | S | Behavior changed to fail-closed (breaking change) |
| GAP-007 | Configuration | envoyAddress in envoyConfig + peer records | **Important** | M | Field in config type but absent from v2 routing state |
| GAP-008 | BGP Protocol | envoyPort rewrite for multi-hop transit | **Important** | M | Not performed — upstream port forwarded as-is |
| GAP-009 | State Management | external field in RouteTable | Minor | S | Field removed from v2 schema |
| GAP-010 | Error Handling | Token minting no retry | Minor | — | Not a gap — v2 improved (5 retries with backoff) |
| GAP-011 | Logging | Per-action dispatch logging + BGP event logs | Minor | S | Reduced verbosity — no dispatch trace, no counts |
| GAP-012 | Configuration | journalPath not wired to config schema | Minor | S | v2 feature half-implemented; TODO comment in code |

---

## Recommended Implementation Order

Dependencies govern the order. Critical gaps block v2 being a functional replacement for v1.

### Phase 1 — Session Establishment (GAP-001, GAP-002, GAP-003)

These three gaps must be fixed together. They are all about the iBGP session lifecycle: establishing it (GAP-001), exchanging routes on both sides when it opens (GAP-002), and tearing it down cleanly (GAP-003).

**Order within Phase 1:**
1. **GAP-001** — Wire `LocalPeerCreate` to initiate outbound dial via `ReconnectManager`. This is the entry point for all iBGP session work. Without it, GAP-002 is only half-testable.
2. **GAP-002** — Add `InternalProtocolOpen` sync path in `bus.ts:handleBGPNotify`. Can be implemented independently but should be verified alongside GAP-001 in an integration test.
3. **GAP-003** — Add `LocalPeerDelete` → `transport.closePeer()` side effect in the bus. Depends on GAP-001 being tested so a live peer exists to close.

### Phase 2 — Validation & Error Quality (GAP-004, GAP-005)

These can be implemented independently after Phase 1.

4. **GAP-004** — Add `peerToken` required check in `planLocalPeerCreate`. Consider whether node name format validation should also be restored (or explicitly documented as removed).
5. **GAP-005** — Add descriptive error returns (separate from `noChange`) for not-found and duplicate cases in RIB plan handlers. This requires adding error state to `PlanResult` or handling these as validation errors before calling `plan()`.

### Phase 3 — Multi-Hop Envoy (GAP-007, GAP-008)

These are coupled: GAP-007 (envoyAddress) needs to be in routing state before GAP-008 (port rewriting) can work correctly for multi-hop.

6. **GAP-007** — Verify whether `envoyAddress` needs to be in v2 routing state. If yes, add to `PeerRecord` in `packages/routing/src/v2/state.ts` and thread through the BGP serialization path.
7. **GAP-008** — Add egress port rewriting in `syncRoutesToPeer()` and `buildUpdatesForPeer()` using `portAllocator.getPort(egressKey)`.

### Phase 4 — Configuration & Auth Behavior (GAP-006, GAP-012)

8. **GAP-006** — Document the fail-closed change explicitly in migration notes. If fail-open for development/test is desired, add an `allowNoAuth` escape hatch to `OrchestratorServiceOptions`.
9. **GAP-012** — Wire `journalPath` into `OrchestratorConfigSchema` and environment variable loading.

### Phase 5 — Cosmetic/Observability (GAP-009, GAP-011)

10. **GAP-009** — Either add `external: {}` back to v2 `RouteTable` for structural parity, or document the removal explicitly.
11. **GAP-011** — Add per-action dispatch logging and key event counters to match v1 log verbosity.

---

## Notes on What Is NOT a Gap

The following v2 behaviors differ from v1 but are **improvements**, not gaps:

- **Plan/commit purity** — v2's strict separation is better than v1's inline mutation.
- **ActionQueue serialization** — prevents TOCTOU races absent in v1.
- **Keepalive / hold timer** — v1 had none; v2 adds full BGP keepalive machinery.
- **Journal persistence** — v1 had no persistence; v2 adds SQLite-backed replay.
- **Graceful restart (stale route marking)** — v1 had none; v2 adds TRANSPORT_ERROR-aware route staling.
- **Reconnect manager with backoff** — v1 had no reconnect; v2 adds exponential backoff.
- **Best-path selection** — v1 did simple upsert by name+peer; v2 prefers shorter paths and replaces stale routes.
- **Peer identity binding in IBGPClient** — v2 verifies JWT sub vs peerInfo.name; v1 had no such check.
- **Token minting retries** — v2 adds 5 retries with backoff; v1 fails immediately.
- **originNode in UpdateMessage** — v2 adds route origin tracking; v1 had no originNode field.
- **CloseCodes enum** — v2 distinguishes transport error from graceful close; v1 used no such enum.
