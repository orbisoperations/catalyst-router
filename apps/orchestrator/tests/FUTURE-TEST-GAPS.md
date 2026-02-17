# Future Test Gaps

BGP-informed edge cases that require implementation changes before they can be tested. Each entry describes what the test would verify, why it matters for production, and what changes are needed.

Research sources: OpenBGPD `rde_decide_test.c`, GoBGP `destination_test.go` + `ibgp_router_test.py` + `fsm_test.go`, FRRouting 252 topotest directories, BIRD `proto/bgp/bgp.c` + `filter/test.conf`.

---

## 1. Graceful Restart / Route Stale Marking

**What it tests:** When a peer disconnects, routes from that peer are marked `stale` rather than immediately deleted. Stale routes remain usable during a configurable grace period. If the peer reconnects, stale routes are refreshed. If the timer expires, stale routes are purged and withdrawals sent.

**Why it matters:** Without this, every momentary peer flap causes a full withdrawal-then-readvertisement cycle across the entire mesh. A 2-second WebSocket blip triggers route churn to all downstream peers. All four major BGP implementations (OpenBGPD, GoBGP, FRR, BIRD) have extensive GR test suites — FRR alone has 8+ test directories for it.

**Changes required:**

- Add `stale?: boolean` and `staleSince?: number` fields to `InternalRoute`
- Add `gracePeriodMs?: number` to `InternalProtocolClose` action data
- Modify `InternalProtocolClose` handler: when `gracePeriodMs` is set, mark routes stale instead of deleting
- Modify `Tick` handler: purge routes where `now - staleSince > gracePeriodMs`
- Modify `computeRouteMetadata`: deprioritize stale routes (treat as infinite path length)
- Modify `InternalProtocolUpdate` handler: un-stale routes that are re-advertised
- Suppress withdrawal propagations during grace period

**Test scenarios (~10 tests):**

- Peer disconnects with GR → routes marked stale, NOT withdrawn
- Peer reconnects within grace period → stale routes refreshed, no downstream churn
- Peer does NOT reconnect → stale routes purged, withdrawals sent after timeout
- Stale route loses best-path to shorter fresh route (de-preference)
- Partial refresh: only some routes re-advertised, rest purged
- End-of-initial-sync marker clears remaining stale routes

---

## 2. Maximum Prefix Limits

**What it tests:** A configurable per-peer limit on the number of routes accepted. When a peer exceeds the limit, new routes are rejected or the session is torn down.

**Why it matters:** Protects against a misbehaving peer flooding the RIB with thousands of routes, exhausting memory or port allocator capacity. Both FRR and OpenBGPD have `maxprefix` integration tests.

**Changes required:**

- Add `maxPrefixes?: number` to `PeerRecord` or `OrchestratorConfig` per-peer settings
- Modify `InternalProtocolUpdate` handler: check route count from that peer before adding
- When limit exceeded: either return `{ success: false }` or produce an `InternalProtocolClose` propagation

**Test scenarios (~6 tests):**

- Accepting routes at exactly the limit succeeds
- Exceeding limit by one causes plan failure
- Batch update that would cross limit is rejected atomically
- Removing routes below limit then adding more succeeds
- Limit of 0 means unlimited (no enforcement)
- Session teardown mode: exceeding limit closes the peer

---

## 3. Route Flap Damping

**What it tests:** A penalty-based system where each withdrawal/re-announcement of the same route increments a counter. Once the penalty exceeds a suppress threshold, the route is suppressed (not propagated, deprioritized in best-path). Penalty decays over time via `Tick`.

**Why it matters:** A service that crashes and restarts repeatedly causes route oscillation across all peers. Without damping, every flap cascades through the entire mesh. FRR has `bgp_dampening_per_peer` and BIRD (via Albatros project) implements RFC 2439.

**Changes required:**

- Add `flapPenalty?: number` and `suppressedUntil?: number` per route (keyed by name+peerName)
- Track flap state in RIB (separate from route table, possibly a `flapState` map)
- On `InternalProtocolUpdate` add for recently-withdrawn route: increment penalty
- On `Tick`: decay penalties by configurable half-life
- In `computeRouteMetadata`: exclude suppressed routes from best-path
- In `computePropagations`: do not propagate suppressed routes

**Test scenarios (~6 tests):**

- Single withdraw/re-add below threshold: route remains usable
- N rapid cycles exceed threshold: route suppressed
- Suppressed route excluded from best-path
- Penalty decays via Tick, route becomes reusable
- Different routes from same peer damped independently
- Suppressed route not propagated to downstream peers

---

## 4. ECMP (Equal-Cost Multipath)

**What it tests:** When multiple peers advertise the same route with equal-length nodePaths, all paths are treated as "active" simultaneously (not just best + alternatives). Enables load-balancing across multiple paths.

**Why it matters:** Currently, the RIB picks a single best path. Traffic always flows through one peer even when equal-cost alternatives exist. FRR has 3 ECMP topotest directories, GoBGP has `TestMultipath`, and BIRD supports ECMP via `merge_paths`.

**Changes required:**

- Add `ecmpPaths?: InternalRoute[]` to `LocRibEntry`
- Modify `computeRouteMetadata`: when multiple routes have identical `nodePath.length`, mark all as ECMP candidates
- Add `selectionReason: 'ecmp'` for multi-path entries
- Modify `buildRouteSyncPayload`: potentially include all ECMP paths in propagation

**Test scenarios (~5 tests):**

- Two routes with identical path length both in ecmpPaths
- Withdrawal of one ECMP path leaves the other active
- Addition of third equal-cost path extends ecmpPaths
- Unequal lengths still produce single best + alternatives (no ECMP)
- ECMP routes propagated with correct port stamping

---

## 5. Import/Export Filters

**What it tests:** Routes pass through configurable import filters (peer→RIB) and export filters (RIB→peer). Filters can accept, reject, or modify routes based on name patterns, tags, region, or other attributes.

**Why it matters:** Currently all routes are accepted unconditionally and propagated to all peers. There's no mechanism for selective routing policies. BIRD's `filter/test.conf` has hundreds of filter assertions, and OpenBGPD's `eval_all.sh` tests community-based filtering.

**Changes required:**

- Define a `RouteFilter` type (accept/reject rules based on route attributes)
- Add `importFilter?: RouteFilter` and `exportFilter?: RouteFilter` to `PeerRecord` or config
- Modify `InternalProtocolUpdate` handler: apply import filter before adding routes
- Modify `computePropagations`: apply export filter per-peer before including routes
- Optionally: keep filtered routes with a `filtered: true` flag (like BIRD's `REF_FILTERED`) for soft reconfiguration

**Test scenarios (~6 tests):**

- Import filter rejects route by name pattern
- Export filter prevents route from being sent to specific peer
- Filtered route not included in full sync on peer connect
- Filter modification: route accepted but with modified attributes
- Soft reconfig: changing filter re-evaluates without session restart

---

## 6. Graceful Shutdown (Drain Signal)

**What it tests:** Before a planned shutdown, a node re-advertises all routes with a "draining" marker. Peers deprioritize drained routes, preferring alternative paths. After traffic drains, the node can shut down safely.

**Why it matters:** Enables zero-downtime rolling deploys of catalyst nodes. FRR has `bgp_gshut` and `bgp_peer_graceful_shutdown` test directories.

**Changes required:**

- Add a `draining?: boolean` field to route propagation
- New action `Actions.AdminGracefulShutdown` that triggers re-propagation of all routes with drain marker
- Modify `computeRouteMetadata` on receiver: add penalty to drained routes' effective path length
- New action to cancel shutdown (remove drain marker)

**Test scenarios (~5 tests):**

- All routes re-propagated with drain marker on shutdown
- Peers deprioritize drained routes in best-path
- Cancelling shutdown removes drain marker
- Drained routes lose to any non-drained alternative

---

## 7. Secondary Metrics (MED / Weight)

**What it tests:** When two routes have equal nodePath length, a secondary metric (analogous to BGP MED or weight) breaks the tie. Lower metric wins. Operators can also set an administrative weight that overrides all other criteria.

**Why it matters:** Without secondary metrics, equal-length path ties are broken arbitrarily by array sort order. OpenBGPD's `rde_decide_test.c` tests 13 tie-breaking steps including MED (step 5) and weight (step 7). Two peers in different datacenters may have same hop count but very different latency.

**Changes required:**

- Add `metric?: number` and/or `adminWeight?: number` to `InternalRoute` or `DataChannelDefinition`
- Modify `computeRouteMetadata` sort: after nodePath length, compare metric (lower wins)
- `adminWeight` overrides nodePath comparison entirely (higher weight always wins)

**Test scenarios (~4 tests):**

- Equal nodePath, different metrics → lower wins
- Admin weight overrides longer nodePath
- Missing metric treated as neutral
- Metric preserved through propagation chain

---

## 8. End-of-RIB / Convergence Delay

**What it tests:** When a peer connects, it sends its routing table followed by an End-of-RIB marker. Until EoR is received, the RIB defers propagation to prevent sending partial state downstream.

**Why it matters:** Currently, each `InternalProtocolUpdate` triggers immediate propagation. If a peer sends 100 routes in 10 messages, downstream peers receive 10 separate propagation messages instead of one. BIRD has `BFS_LOADING` state, FRR has `bgp_update_delay`.

**Changes required:**

- Add `loading?: boolean` to `PeerRecord`
- Set `loading: true` on `InternalProtocolOpen`
- New action or update marker for End-of-RIB
- Modify `computePropagations`: defer propagation while source peer is loading
- On EoR: propagate all accumulated routes at once
- Timeout: if EoR not received within N seconds, propagate anyway

**Test scenarios (~4 tests):**

- Peer marked as loading on connect → updates stored but not propagated
- EoR received → all accumulated routes propagated at once
- Loading timeout → routes propagated anyway
- Non-loading peer updates propagated immediately

---

## 9. Conditional Advertisement

**What it tests:** Routes are only advertised to a peer if a condition is met — e.g., "only advertise frontend-api to peer C if database-api exists in the RIB." If the condition route is withdrawn, the dependent route is also withdrawn.

**Why it matters:** Enables dependency-based routing in service mesh topologies. FRR has `bgp_conditional_advertisement` and `bgp_conditional_advertisement_track_peer` test directories.

**Changes required:**

- Add `advertisementCondition?: { routeName: string; mode: 'exist' | 'non-exist' }` per peer+route
- Modify `computePropagations`: evaluate condition before including route in propagation
- On condition route withdrawal: re-evaluate and potentially withdraw dependent routes

**Test scenarios (~5 tests):**

- Route propagated when condition route present
- Route withdrawn when condition route removed
- Condition route re-added re-triggers advertisement
- Non-exist mode inverts the condition
- Condition evaluated per-peer independently

---

## 10. Peer Session Flap Detection

**What it tests:** Tracking rapid connect/disconnect cycles at the session level. If a peer disconnects and reconnects N times within a window, it's flagged as flapping and route propagation is suppressed.

**Why it matters:** A peer with an unstable network connection causes repeated full sync operations across the mesh. Without session-level damping, every reconnect triggers full route propagation to all peers. BIRD's connect delay timers provide implicit damping.

**Changes required:**

- Add `flapCount?: number` and `lastDisconnect?: number` to `PeerRecord`
- On `InternalProtocolClose`: increment flapCount, record timestamp
- On `InternalProtocolOpen`: check flapCount within window, defer full sync if flapping
- On `Tick`: reset flapCount after stability period

**Test scenarios (~5 tests):**

- Peer connects/disconnects N times → detected as flapping
- Flapping peer's full sync deferred
- Stability period resets flap counter
- Non-flapping peer treated normally
- Flap counter decays over time

---

## 11. Route Aggregation

**What it tests:** When multiple peers advertise the same route name, only the best/aggregated version is propagated downstream (instead of all individual entries). Reduces update volume.

**Why it matters:** Currently, `buildRouteSyncPayload` sends all internal routes to downstream peers. With N peers advertising the same service, downstream receives N copies. BIRD 3.x has a dedicated aggregator protocol with tests.

**Changes required:**

- Modify `buildRouteSyncPayload`: for each unique route name, only include the best path (from `routeMetadata`)
- Modify `computePropagations` for `InternalProtocolUpdate`: if a new route doesn't change the best path, suppress propagation
- If best path changes: send update with new best attributes (not withdrawal+add)

**Test scenarios (~4 tests):**

- Multiple peers advertise same route → only best propagated
- Withdrawal of best → alternative promoted, update (not withdrawal) sent downstream
- New better path → downstream receives single update
- Aggregated attributes reflect best candidate
