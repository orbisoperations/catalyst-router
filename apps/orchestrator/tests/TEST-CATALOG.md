# Orchestrator Test Catalog

Complete inventory of all orchestrator tests with explanations of what each verifies and why it matters. Organized by layer: unit tests exercise the RIB in isolation, integration tests validate multi-node orchestrator logic with mocked transport, and container tests run full Docker topologies.

**Current totals:** 206 tests across 37 files

---

## Unit Tests: RIB Core (`rib.test.ts`)

The Routing Information Base is the stateful core of the orchestrator. It implements a plan/commit pipeline inspired by BGP's Adj-RIB-In/Loc-RIB model. Every state mutation flows through `plan()` (pure computation) then `commit()` (side effects).

### Plan/Commit Purity (3 tests)

| Test                                              | Why It Matters                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan() does not mutate RIB state`                | The plan/commit split guarantees that planning is side-effect-free. If plan mutated state, concurrent callers would see corrupted intermediate states. |
| `plan() returns prevState equal to current state` | Establishes the optimistic concurrency baseline — prevState is the snapshot callers can use to detect stale plans.                                     |
| `plan() computes newState without applying it`    | Ensures the caller can inspect what _would_ happen before committing, enabling dry-run and validation workflows.                                       |

### Commit Behavior (4 tests)

| Test                                           | Why It Matters                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `commit() applies newState from plan`          | Verifies the fundamental contract: after commit, `getState()` reflects the planned changes.                                 |
| `routesChanged true when local routes change`  | The `routesChanged` flag drives Envoy config pushes — false positives waste bandwidth, false negatives cause stale proxies. |
| `routesChanged false when only peers change`   | Prevents unnecessary Envoy reconfiguration when only peer metadata (not routes) changes.                                    |
| `commit() includes propagations from the plan` | Propagations drive the iBGP protocol — missing propagations mean routes don't reach peers.                                  |

### State Transitions (13 tests)

| Test                                                          | Why It Matters                                                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `LocalPeerCreate adds peer with initializing status`          | Peers must start in `initializing` to prevent premature route propagation before the transport is ready.                            |
| `LocalPeerCreate fails without peerToken`                     | peerToken is the authentication credential for iBGP sessions — creating a peer without one would allow unauthenticated connections. |
| `LocalPeerCreate fails for duplicate peer`                    | Prevents silent overwrite of existing peer configuration and connection state.                                                      |
| `LocalPeerUpdate modifies existing peer`                      | Enables live reconfiguration of peer endpoints without tearing down and rebuilding the session.                                     |
| `LocalPeerDelete removes peer`                                | Clean resource teardown — ensures no orphaned peer records accumulate.                                                              |
| `InternalProtocolOpen sets status to connected`               | The `connected` status gates route propagation — only connected peers receive updates.                                              |
| `InternalProtocolOpen fails for unknown peer`                 | Prevents accepting connections from peers not in the local configuration, which would bypass access control.                        |
| `InternalProtocolConnected sets status to connected`          | The outbound connection path (we initiated) must also transition to connected for bidirectional routing.                            |
| `InternalProtocolClose removes peer and routes`               | Ensures no zombie routes survive a session teardown — critical for routing table accuracy.                                          |
| `LocalRouteCreate adds route`                                 | Verifies the basic local service registration that drives the entire routing mesh.                                                  |
| `LocalRouteCreate fails for duplicate route`                  | Prevents accidental double-registration which could mask configuration errors.                                                      |
| `LocalRouteDelete removes route`                              | Clean deregistration when a local service shuts down.                                                                               |
| `InternalProtocolUpdate adds/upserts/removes internal routes` | The core iBGP message processing — add, implicit withdrawal (upsert), and explicit withdrawal.                                      |

### Loop Prevention (2 tests)

| Test                                             | Why It Matters                                                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drops updates containing this node in nodePath` | Prevents routing loops — without this, a route could circulate indefinitely through the mesh, consuming bandwidth and causing count-to-infinity problems. |
| `accepts updates not containing this node`       | Ensures legitimate multi-hop routes are not incorrectly rejected.                                                                                         |

### Propagation Computation (8 tests)

| Test                                                       | Why It Matters                                                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LocalPeerCreate produces open propagation`                | The `open` propagation tells the transport layer to initiate the WebSocket connection to the new peer.                                             |
| `LocalRouteCreate broadcasts to connected peers only`      | Initializing peers have no transport — sending to them would fail silently and cause route divergence.                                             |
| `LocalRouteDelete sends remove to connected peers`         | Without withdrawal propagation, remote peers would continue routing to a deregistered service.                                                     |
| `LocalPeerDelete produces close + withdrawal`              | Close tells transport to tear down the connection; withdrawals tell remaining peers to stop routing through the deleted peer.                      |
| `InternalProtocolUpdate excludes source peer`              | Sending a route back to the peer that advertised it wastes bandwidth and can cause oscillation.                                                    |
| `InternalProtocolUpdate filters loops in re-advertisement` | Extends loop prevention to the propagation layer — even if a route is stored locally, it must not be forwarded to peers already in its path.       |
| `InternalProtocolUpdate prepends this node to nodePath`    | The nodePath is our AS_PATH analog — prepending ensures downstream peers can detect loops and compute accurate hop counts for best-path selection. |
| `InternalProtocolClose propagates withdrawals`             | When a peer goes down, its routes become unreachable — remaining peers must be notified immediately to avoid black-holing traffic.                 |

### Full Sync on Peer Connect (2 tests)

| Test                                                           | Why It Matters                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `produces full table sync with local and internal routes`      | A newly connected peer needs the complete routing table to participate in the mesh — incremental updates alone would leave it with an incomplete view. |
| `excludes routes with target peer in nodePath (split horizon)` | Prevents sending a peer its own routes back during full sync, which would cause loops and waste bandwidth.                                             |

### Port Operations (10 tests)

| Test                                                      | Why It Matters                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `LocalRouteCreate includes allocate operation`            | Each local route needs an Envoy listener port — without allocation, the proxy can't accept traffic for the service. |
| `LocalRouteDelete includes release operation`             | Port exhaustion prevention — released ports can be reused by new services.                                          |
| `InternalProtocolUpdate includes egress allocate`         | Egress ports enable Envoy to proxy traffic to remote services learned from peers.                                   |
| `InternalProtocolClose includes release for egress ports` | Releases egress ports when a peer disconnects, preventing port exhaustion during peer churn.                        |
| `empty portOperations for non-route actions`              | Prevents spurious port allocation on peer-only operations which would waste resources.                              |
| `empty portOperations without port allocator`             | Ensures backward compatibility when running without Envoy.                                                          |
| `portOperations passed through to CommitResult`           | The orchestrator needs port operations in the commit result to execute Envoy config pushes.                         |
| `plan() does NOT mutate the port allocator`               | Maintains plan/commit purity — port allocation only happens on commit, not during speculative planning.             |
| `commit() stamps envoyPort on local routes`               | Routes must carry their allocated port so Envoy config generation knows which listener to create.                   |
| `commit() stamps egress ports on internal routes`         | Internal routes need local egress ports (not the remote peer's port) for correct proxy configuration.               |

---

## Unit Tests: Route Metadata (`route-metadata.test.ts`)

Route metadata implements best-path selection — the BGP decision process equivalent that determines which of multiple paths to a service is preferred.

| Test                                                | Why It Matters                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `single route has reason 'only candidate'`          | Baseline: when there's only one path, no comparison is needed and the reason is self-documenting.                   |
| `two peers: shorter nodePath selected as best`      | Core routing correctness — shorter paths mean fewer hops, lower latency, and fewer points of failure.               |
| `withdrawal removes route from metadata`            | When the best path is withdrawn, the alternative must be promoted — failure here means traffic black-holes.         |
| `peer disconnect removes routes from metadata`      | Ensures metadata stays synchronized with state after peer teardown.                                                 |
| `metadata accessible via getRouteMetadata()`        | Public API contract — external consumers (envoy config, health checks) depend on this.                              |
| `metadata only tracks internal routes`              | Local routes are directly served — they don't need best-path selection since there's only one provider (this node). |
| `withdrawal of all routes removes metadata entry`   | Prevents stale metadata entries from accumulating, which could cause incorrect routing decisions.                   |
| `multiple distinct routes produce separate entries` | Each service name is an independent routing decision — they must not interfere with each other.                     |

---

## Unit Tests: Keepalive / Hold Timer (`keepalive.test.ts`)

The tick-driven keepalive mechanism detects dead peers and maintains session liveness, analogous to BGP's hold timer (RFC 4271 Section 4.4).

| Test                                                        | Why It Matters                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `expires peer when hold timer exceeded`                     | Dead peer detection is critical — without it, traffic continues routing to unreachable nodes indefinitely.    |
| `does not expire peer within holdTime`                      | Prevents premature peer expiry during normal operation, which would cause unnecessary route churn.            |
| `expired peer routes are withdrawn from state`              | Routes through a dead peer are unreachable — keeping them in state causes traffic black-holes.                |
| `expired peer routes propagated as withdrawals`             | Downstream peers must learn about the dead peer to reroute traffic through surviving paths.                   |
| `sends keepalive when interval exceeded`                    | Keepalives prevent the _remote_ peer from expiring _us_ — without them, our peers think we're dead.           |
| `does not send keepalive within interval`                   | Rate-limits keepalive traffic to avoid wasting bandwidth (BGP uses holdTime/3 as the interval).               |
| `no-op when no peers have holdTime`                         | Backward compatibility — peers without holdTime are legacy and should not be affected by the timer mechanism. |
| `no-op with empty peer list`                                | Defensive: tick on an empty mesh should not crash or produce spurious propagations.                           |
| `expirations processed before keepalives`                   | Prevents sending keepalives to a peer that was just expired in the same tick — would be a protocol violation. |
| `InternalProtocolOpen/Connected/Update update lastReceived` | Every message from a peer resets its hold timer — this is how the peer proves it's still alive.               |
| `commit updates lastSent for peers receiving propagations`  | Tracks when we last sent data to a peer, enabling the keepalive interval calculation.                         |

---

## Unit Tests: BGP Edge Cases (23 files, ~97 tests)

These tests are modeled after patterns from four major BGP implementations (OpenBGPD, GoBGP, FRRouting, BIRD) and cover failure modes that are well-tested in production routing software.

### Loop Detection (`bgp-loop-detection.test.ts` — 6 tests)

_Inspired by: GoBGP `TestCheckOwnASLoop`, FRR `bgp_sender_as_path_loop_detection`_

Routing loops are the most dangerous failure mode in any routing protocol. A loop causes packets to circulate indefinitely, consuming bandwidth and causing exponential amplification. These tests verify that the nodePath (our AS_PATH analog) is correctly checked at every ingestion and propagation point.

| Test                                                           | Why It Matters                                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `own node at end of multi-hop path → dropped`                  | Catches the common case where a route loops back through a chain of peers.                         |
| `own node at start of nodePath → dropped`                      | Catches a direct reflection where our own advertisement comes back from a neighbor.                |
| `empty nodePath accepted`                                      | Freshly originated routes have no path — they must not be rejected by loop detection.              |
| `route with target peer in nodePath not propagated`            | Split-horizon on re-advertisement prevents forwarding a route to a peer that would create a loop.  |
| `all peers filtered = zero propagations`                       | When every eligible peer is in the path, the route must not be sent anywhere.                      |
| `safe routes in batch still propagate despite looped siblings` | Looped routes in a batch must not poison the entire batch — each route is evaluated independently. |

### Withdrawal Ordering (`bgp-withdrawal-ordering.test.ts` — 6 tests)

_Inspired by: GoBGP `ExplicitWithdraw`/`ImplicitWithdraw`, FRR `bgp_suppress_duplicates`_

Withdrawal ordering bugs cause the most subtle routing problems. A route that appears present but isn't (or vice versa) causes silent traffic loss that's extremely hard to diagnose.

| Test                                          | Why It Matters                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `withdraw nonexistent route is no-op`         | Idempotent withdrawals prevent crashes from duplicate or out-of-order messages over unreliable transport. |
| `double withdraw is idempotent`               | Network retransmission can duplicate withdrawal messages — must be handled gracefully.                    |
| `add after withdraw results in route present` | Verifies that temporal ordering is respected — the last action wins.                                      |
| `implicit withdrawal (upsert)`                | Second add from same peer replaces first — this is the primary mechanism for route attribute updates.     |
| `mixed add/remove in single message`          | Tests atomicity: within a single update message, operations must be applied in order.                     |
| `interleaved multi-route update`              | Each route in a batch is independent — add A, remove B, add C must all succeed independently.             |

### Best-Path Selection (`bgp-best-path-selection.test.ts` — 5 tests)

_Inspired by: OpenBGPD `rde_decide_test.c`, GoBGP `TestNeighAddrTieBreak`_

Best-path selection determines which peer's route is used for forwarding. Incorrect selection causes suboptimal routing (longer paths, higher latency) or complete routing failures.

| Test                                                | Why It Matters                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `equal-length nodePath: deterministic tie-breaking` | Without determinism, two nodes could disagree on the best path, causing routing oscillation.              |
| `best-path promotion after withdrawal`              | When the preferred path fails, traffic must seamlessly fail over to the alternative.                      |
| `selection stability on re-insertion`               | Verifies that best-path selection is consistent — removing and re-adding should produce the same result.  |
| `three-way path comparison`                         | Tests the full sort with 3 candidates of different lengths — catches off-by-one errors in the comparator. |
| `metadata tracks multiple routes independently`     | Different service names must have completely independent best-path decisions.                             |

### Session Lifecycle (`bgp-session-lifecycle.test.ts` — 6 tests)

_Inspired by: GoBGP FSM tests, FRR `bgp_peer_shut`_

Session lifecycle edge cases are a common source of production incidents. A peer that can't be cleanly disconnected and reconnected will accumulate stale state.

| Test                                        | Why It Matters                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `double open is idempotent`                 | Network race conditions can cause duplicate open messages — must not corrupt peer state.        |
| `close on unknown peer is no-op`            | Late-arriving close messages for already-removed peers must not crash.                          |
| `delete before connect succeeds`            | A peer that was configured but never connected must still be cleanly removable.                 |
| `update resets connectionStatus`            | Reconfiguring a peer (new endpoint) must reset it to initializing to force a clean reconnect.   |
| `multi-peer disconnect: all routes removed` | Validates thorough cleanup when multiple peers disconnect simultaneously.                       |
| `reconnect after close: fresh session`      | The most critical lifecycle test — a reconnected peer must start with a completely clean slate. |

### Batch Updates (`bgp-batch-updates.test.ts` — 4 tests)

_Inspired by: FRR `bgp_batch_clearing`_

Batch processing is the normal mode — peers don't send routes one at a time. Bugs in batch handling cause partial state updates.

| Test                                   | Why It Matters                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `batch add: 3 routes in one update`    | Verifies that all routes in a batch are processed, not just the first.                           |
| `batch remove: 3 routes in one update` | Same for removals — partial removal leaves zombie routes.                                        |
| `batch propagation to downstream`      | A single upstream batch should produce a single downstream propagation, not N separate messages. |
| `partial loop filtering in batch`      | A looped route in a batch must not prevent valid routes in the same batch from being processed.  |

### Split Horizon (`bgp-split-horizon.test.ts` — 5 tests)

_Inspired by: GoBGP `ibgp_router_test.py test_03/test_16`_

Split horizon is the iBGP rule that prevents re-advertising routes back to their source. Without it, routes bounce between peers indefinitely.

| Test                                            | Why It Matters                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `local routes always propagated`                | Local routes originate here — they must reach all peers regardless of split-horizon rules.                   |
| `full sync excludes routes with target in path` | The initial table dump on peer connect must respect split-horizon, not just incremental updates.             |
| `nodePath prepended on re-advertisement`        | This node must be added to the path so downstream peers know the route traversed us.                         |
| `remove actions bypass loop filter`             | Withdrawals must always be forwarded — if we suppress a withdrawal, the downstream peer keeps a stale route. |
| `source peer excluded from re-advertisement`    | The most basic split-horizon rule: never send a route back to the peer that sent it.                         |

### Hold Timer Edge Cases (`bgp-hold-timer-edge-cases.test.ts` — 7 tests)

_Inspired by: GoBGP `TestFSMHandlerOpenconfirm_HoldtimeZero`, FRR `bgp_minimum_holdtime`_

Hold timer boundary conditions are notoriously tricky. Off-by-one errors cause either premature expiry (route churn) or delayed detection (traffic black-holes).

| Test                                         | Why It Matters                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `holdTime=0 → immediate expiry`              | Documents our implementation's behavior (differs from RFC 4271 which treats 0 as infinite).           |
| `holdTime undefined → no expiry`             | Backward compatibility: legacy peers without holdTime must never be expired.                          |
| `exactly at holdTime → NOT expired`          | The boundary condition: `elapsed == holdTime` is not expired (must be strictly greater).              |
| `1ms past holdTime → expired`                | The first moment past the boundary must trigger expiry — no off-by-one tolerance.                     |
| `keepalive at exactly holdTime/3 → NOT sent` | Same boundary logic for keepalive interval — must be strictly greater.                                |
| `lastSent undefined → no keepalive`          | New peers without lastSent have never been sent to — must not trigger keepalive logic.                |
| `multiple peers expire same tick`            | Simultaneous expiry must handle all peers atomically — partial expiry would leave inconsistent state. |

### Zombie Routes (`bgp-zombie-routes.test.ts` — 6 tests)

_Inspired by: RIPE Labs BGP Zombies research, GoBGP `TestEBGPRouteStuck`_

Zombie routes are entries that persist after their source is gone. They're the routing equivalent of a memory leak — traffic gets sent to endpoints that no longer exist.

| Test                                         | Why It Matters                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `close removes ALL routes from peer`         | The fundamental anti-zombie guarantee: no route survives its peer's departure.                       |
| `routes from closed peer not in getState()`  | Defense in depth: even if internal cleanup has a bug, the public API must not expose zombies.        |
| `plan reflects latest state after mutations` | Ensures the plan/commit pipeline doesn't have stale state bugs that could resurrect zombies.         |
| `withdrawal propagation includes all routes` | Other peers must be told about every route that died — missing a withdrawal creates a remote zombie. |
| `LocalPeerDelete removes peer and routes`    | Both the administrative delete path and the protocol close path must clean up routes.                |
| `route removal propagates to other peers`    | Explicit single-route withdrawal (not peer close) must also be propagated.                           |

### Port Allocation + Envoy (`bgp-port-allocation-envoy.test.ts` — 6 tests)

These tests verify the Envoy sidecar integration at the RIB level — port allocation, egress rewriting, and cleanup.

| Test                                           | Why It Matters                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `egress port allocated on internal route`      | Without an egress port, Envoy can't proxy traffic to remote services learned from peers.                    |
| `multi-hop uses local egress port, not remote` | Each node needs its own egress port — using the remote peer's port would route to the wrong Envoy instance. |
| `full sync uses stamped egress ports`          | The initial table dump to new peers must carry correct local ports, not stale remote ports.                 |
| `no envoyPort without envoyConfig`             | Nodes running without Envoy must not have spurious port values that confuse downstream consumers.           |
| `pre-existing envoyPort preserved`             | The `stampPortsOnState` guard prevents overwriting ports that were already set by the remote peer.          |
| `close releases egress ports`                  | Port exhaustion prevention: every allocated port must be released when no longer needed.                    |

### Propagation Correctness (`bgp-propagation-correctness.test.ts` — 5 tests)

_Inspired by: FRR `bgp_conditional_advertisement`, OpenBGPD `eval_all.sh`_

Propagation correctness ensures that the right peers receive the right updates at the right time.

| Test                                             | Why It Matters                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `only connected peers receive propagations`      | Sending to initializing peers would fail on the transport and cause error noise.                  |
| `LocalRouteDelete sends remove to peers`         | Service deregistration must be propagated — without this, peers route to dead endpoints.          |
| `tick withdrawal targets survivors, not expired` | An expired peer's own WebSocket is dead — sending withdrawals to it is pointless and would error. |
| `no propagation with zero connected peers`       | Defensive: a route added to an isolated node should not attempt any network operations.           |
| `close withdrawal includes all routes`           | Every route from the closed peer must be withdrawn — a partial withdrawal leaves remote zombies.  |

### Plan Error Paths (`bgp-plan-error-paths.test.ts` — 6 tests)

Every guard clause that returns `{ success: false }` must be exercised. Untested error paths are a common source of crashes in production when unexpected inputs arrive.

| Test                                     | Why It Matters                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `LocalPeerUpdate for nonexistent peer`   | Updating a peer that doesn't exist could corrupt state if the error path has a bug.        |
| `LocalPeerDelete for nonexistent peer`   | Deleting a nonexistent peer should fail gracefully, not crash or leave state inconsistent. |
| `LocalRouteDelete for nonexistent route` | Same principle for routes — defensive error handling at every operation boundary.          |
| `LocalPeerCreate without peerToken`      | Authentication is mandatory — this guard prevents unauthenticated peer creation.           |
| `LocalPeerCreate for existing peer`      | Duplicate prevention — creating the same peer twice would corrupt the existing session.    |
| `LocalRouteCreate for existing route`    | Duplicate prevention — double-registration could mask configuration errors.                |

### InternalProtocolConnected (`bgp-protocol-connected.test.ts` — 4 tests)

The `Connected` action is the outbound connection path. Prior to these tests, it had zero propagation-level coverage.

| Test                                           | Why It Matters                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `unknown peer is silent no-op`                 | A connection callback for an unconfigured peer must not crash or create phantom state.    |
| `produces full sync when routes exist`         | The outbound connection must trigger the same full table dump as the inbound path.        |
| `empty RIB produces zero propagations`         | No routes = no sync needed — sending an empty update wastes bandwidth.                    |
| `missing peerToken produces zero propagations` | Without authentication credentials, we cannot send updates — this is a security boundary. |

### Empty RIB Sync (`bgp-empty-rib-sync.test.ts` — 2 tests)

Tests the early-return path in `computePropagations` when there are no routes to sync.

| Test                                                      | Why It Matters                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `InternalProtocolOpen with empty RIB → zero propagations` | Prevents sending empty update messages which would waste bandwidth and confuse peers. |
| `InternalProtocolOpen with routes → sync propagation`     | Confirms the happy path works and includes the peer's authentication token.           |

### nodePath Undefined Fallback (`bgp-nodepath-undefined-fallback.test.ts` — 2 tests)

The `?? []` fallback in both `computeNewState` and `computePropagations` handles the case where nodePath is literally `undefined`.

| Test                                                     | Why It Matters                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `undefined nodePath defaults to empty array in state`    | Without this fallback, `.includes()` would throw on `undefined`, crashing the RIB.          |
| `undefined nodePath in propagation filter doesn't crash` | Same protection in the propagation path — both ingestion and re-advertisement must be safe. |

### routesChanged Flag (`bgp-routes-changed-flag.test.ts` — 4 tests)

The `routesChanged` boolean drives Envoy config pushes. Incorrect values cause either missed updates or unnecessary reconfiguration.

| Test                               | Why It Matters                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `true when internal routes change` | Internal route changes require Envoy egress reconfiguration.                          |
| `true when local routes change`    | Local route changes require Envoy listener reconfiguration.                           |
| `false for peer-only changes`      | Adding/removing peers without route changes should not trigger Envoy reconfiguration. |
| `false for InternalProtocolOpen`   | Opening a peer changes its status but not routes — no Envoy update needed.            |

### lastSent Tracking (`bgp-last-sent-tracking.test.ts` — 2 tests)

The `lastSent` timestamp drives keepalive interval calculation. Incorrect tracking causes either missing keepalives (peer expires us) or excessive keepalives (bandwidth waste).

| Test                               | Why It Matters                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `not updated for open propagation` | The `open` message is a connection establishment signal, not a data transfer — it should not reset the keepalive timer. |
| `updated for update propagation`   | Sending route data to a peer proves we're alive — this correctly resets the keepalive timer.                            |

### Upsert Propagation (`bgp-upsert-propagation.test.ts` — 2 tests)

_Inspired by: GoBGP `TestRTCWithdrawUpdatedPath`_

| Test                                         | Why It Matters                                                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sends single add on upsert`                 | The propagation contract: upserts are sent as `add` (relying on receiver-side upsert), not `remove+add` which would cause a momentary traffic gap. |
| `implicit withdrawal recalculates best-path` | When a peer changes its route attributes (e.g., longer path), the best-path must be re-evaluated — failure causes suboptimal routing.              |

### Insertion-Order Independence (`bgp-insertion-order-independence.test.ts` — 2 tests)

_Inspired by: OpenBGPD `test_evaluate()` which tests all N! permutations_

| Test                                              | Why It Matters                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `2 peers: same winner regardless of order`        | If best-path depends on insertion order, two nodes with the same routes could disagree on the best path, causing routing loops. |
| `3 peers: all 6 permutations produce same winner` | Exhaustive permutation test catches sort instability bugs that only manifest with 3+ candidates.                                |

### Plan State Isolation (`bgp-plan-state-isolation.test.ts` — 2 tests)

_Inspired by: GoBGP's immutable state design_

| Test                                        | Why It Matters                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `two plans have independent route lists`    | JavaScript's shallow copy semantics make shared references a footgun — two plans from the same state must not share mutable arrays. |
| `committing plan A does not corrupt plan B` | In an async system, one plan may be committed while another is still pending — the pending plan's state must remain valid.          |

### Peer Churn Stability (`bgp-peer-churn-stability.test.ts` — 2 tests)

_Inspired by: GoBGP `TestNumGoroutineWithAddDeleteNeighbor`_

| Test                                            | Why It Matters                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `100 connect/close cycles → zero state`         | Proves no state accumulates over time — a resource leak here would eventually crash the node.    |
| `20 port allocator cycles → all ports released` | Port exhaustion is a hard failure — once all ports are consumed, no new services can be proxied. |

### N-Way Route Tie (`bgp-nway-route-tie.test.ts` — 3 tests)

_Inspired by: GoBGP `TestMultipath`_

| Test                                             | Why It Matters                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `3 peers with equal paths: all stored`           | All candidates must be retained for failover — dropping alternatives means no backup path.                       |
| `withdrawal from 3-way tie: alternatives shrink` | Metadata must stay accurate as candidates are removed — stale alternatives cause incorrect failover.             |
| `all withdraw: metadata cleaned up`              | When a service is completely unreachable, its metadata entry must be removed to prevent stale routing decisions. |

### Local Route Preference (`bgp-local-route-preference.test.ts` — 2 tests)

_Inspired by: BIRD `DEF_PREF_DIRECT > DEF_PREF_BGP`_

| Test                                            | Why It Matters                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `local and internal routes coexist`             | A node can both serve a service locally and know about the same service on remote peers — these must not interfere. |
| `deleting local route does not affect internal` | Namespace isolation: local and internal route operations are completely independent.                                |

### Scale / Stress (`bgp-scale-stress.test.ts` — 3 tests)

_Inspired by: GoBGP `BenchmarkMultiPath`, BIRD table GC tests_

| Test                                           | Why It Matters                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `100 routes in single full sync`               | Validates that the sync mechanism handles large route tables without off-by-one or pagination errors.                     |
| `bulk add then bulk remove → clean state`      | Verifies atomic batch operations leave no residue — partial cleanup would accumulate zombie routes.                       |
| `metadata map size matches unique route names` | After churn involving overlapping routes from multiple peers, the metadata map must accurately reflect the current state. |

---

## Unit Tests: Action Queue (`action-queue.test.ts`)

The ActionQueue serializes concurrent dispatches to the RIB, preventing race conditions.

| Test                                   | Why It Matters                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `serializes concurrent dispatches`     | Without serialization, two concurrent route adds could see the same prevState and one would silently overwrite the other. |
| `single dispatch resolves immediately` | No unnecessary latency when there's no contention.                                                                        |
| `propagates pipeline rejection`        | Callers need to know when their action failed so they can retry or report the error.                                      |
| `continues after rejection`            | One failed action must not block the entire queue — the system must remain operational.                                   |

---

## Unit Tests: Peer Transport (`peer-transport.test.ts`)

The PeerTransport handles the gRPC/WebSocket communication with remote peers.

| Test                                    | Why It Matters                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `sendUpdate uses peer token`            | Authentication is per-peer — using the wrong token would fail or connect to the wrong node.                |
| `sendOpen calls client.open`            | The open message initiates the iBGP session with the remote peer.                                          |
| `sendClose calls client.close`          | Clean session teardown prevents the remote peer from keeping stale state.                                  |
| `fanOut runs concurrently`              | Propagations to multiple peers must not be serialized — that would add latency proportional to peer count. |
| `fanOut handles mixed types`            | A single commit can produce open, update, and close propagations — all must be dispatched correctly.       |
| `fanOut settles failures independently` | One failed peer must not prevent updates to other peers — the mesh must remain partially functional.       |
| `throws without peerToken or nodeToken` | Prevents sending unauthenticated messages which would be rejected by the remote peer.                      |
| `falls back to nodeToken`               | When a specific peer token isn't available, the node-level token provides a fallback authentication path.  |

---

## Integration Tests: Multi-Node Orchestrator

These tests create multiple `CatalystNodeBus` instances with mocked transport to test end-to-end routing behavior.

### Envoy Integration (`orchestrator.envoy.test.ts` — 13 tests)

Tests the full orchestrator-to-Envoy pipeline: port allocation, config push, multi-hop port rewriting, and cleanup.

| Key Tests                                          | Why They Matter                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `allocates port and pushes config on create`       | The complete flow from route registration to Envoy listener creation.                             |
| `releases port on delete`                          | Envoy must remove the listener when a service deregisters.                                        |
| `egress port on internal route`                    | Remote services need outbound proxy configuration.                                                |
| `rewrites envoyPort in multi-hop re-advertisement` | Each hop must use its own egress port — using the upstream's port would route to the wrong Envoy. |
| `logs error but doesn't crash on port exhaustion`  | Graceful degradation when all ports are consumed.                                                 |
| `idempotent allocation`                            | Re-dispatching the same route must not consume additional ports.                                  |
| `envoyPort populated before BGP broadcast`         | Ordering guarantee: peers must receive routes with ports already assigned.                        |

### Gateway Integration (`orchestrator.gateway.test.ts` — 3 tests)

Tests GraphQL gateway synchronization — only GraphQL routes are synced to the gateway service.

### Topology Tests (`orchestrator.topology.test.ts` — 4 tests)

Tests multi-node route propagation, initial sync, withdrawal on disconnect, and loop prevention in linear and cyclic topologies.

### Peering Tests (`peering.orchestrator.topology.test.ts` — 3 tests)

Tests bidirectional peering, pre-peering route sync, and peerToken validation.

### Transit Tests (`transit.orchestrator.topology.test.ts` — 1 test)

Tests the full A↔B↔C transit topology including propagation, withdrawal, and disconnect cleanup.

---

## Container Tests: Full Docker Topologies

These tests build Docker images, start real containers, and validate end-to-end behavior over actual network connections.

### Container Orchestrator (`orchestrator.container.test.ts` — 5 tests)

Full Docker A↔B peering and A↔B↔C transit with real WebSocket transport.

### Container Gateway (`orchestrator.gateway.container.test.ts` — 2 tests)

End-to-end GraphQL gateway sync through the mesh with both shared and separate auth configurations.

### Container Peering (`peering.orchestrator.topology.container.test.ts` — 4 tests)

Docker peering tests with shared auth (single auth server) and separate auth (per-node auth servers with minted peer tokens).

### Container Transit (`transit.orchestrator.topology.container.test.ts` — 2 tests)

Docker transit tests (A↔B↔C) with shared and separate auth servers, validating propagation, sync, and withdrawal over real transport.

---

## Routing Package Unit Tests (`packages/routing/tests/unit/`)

Schema validation tests for the `@catalyst/routing` package's Zod schemas.

### DataChannel Core Fields (`datachannel-core-fields.test.ts` — 5 tests)

| Test                           | Why It Matters                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `accepts minimal definition`   | Validates the minimum viable route definition (name + protocol).                      |
| `accepts all optional fields`  | Ensures endpoint, region, and tags are correctly parsed when present.                 |
| `accepts all protocol types`   | All 5 protocol types (http, http:graphql, http:gql, http:grpc, tcp) must be accepted. |
| `rejects unsupported protocol` | Invalid protocols must be caught at the schema boundary, not deep in routing logic.   |
| `rejects invalid endpoint URL` | Malformed URLs would cause connection failures — reject at ingestion.                 |

### DataChannel Envoy Port (`datachannel-envoy-port.test.ts` — 5 tests)

| Test                                    | Why It Matters                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `defaults to undefined when omitted`    | envoyPort is optional — nodes without Envoy must not have spurious port values. |
| `accepts valid integer port`            | Happy path: a valid port number is preserved.                                   |
| `rejects non-integer port`              | Envoy requires integer ports — a float would cause listener creation failures.  |
| `accepts port boundaries (1 and 65535)` | Edge cases at the valid port range extremes.                                    |
| `accepts alongside all other fields`    | envoyPort must coexist with all other DataChannel fields without interference.  |

### Tick Message Schema (`tick-message-schema.test.ts` — 5 tests)

| Test                           | Why It Matters                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `accepts valid tick`           | The tick message drives the entire keepalive/expiry mechanism — it must parse correctly. |
| `rejects missing now`          | Without a timestamp, the tick cannot compute hold timer expiry.                          |
| `rejects non-numeric now`      | A string timestamp would cause incorrect arithmetic in timer calculations.               |
| `rejects missing data`         | The data payload is required — a tick without data is structurally invalid.              |
| `rejects non-tick action type` | Schema discrimination must correctly identify tick vs other action types.                |

### Action Schema (`action-schema.test.ts` — 2 tests)

| Test                                     | Why It Matters                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `accepts system:tick via unified schema` | The discriminated union correctly routes tick messages to the TickMessageSchema.          |
| `Actions.Tick equals "system:tick"`      | The constant value is correct — a mismatch would cause all tick messages to fail parsing. |
