# v2 Routing System — Test Catalog

Comprehensive catalog of all tests covering the v2 BGP-inspired routing system.
**234 tests** across 18 test files in two packages.

## Summary

| Layer                    | Package             | Files  | Tests   |
| ------------------------ | ------------------- | ------ | ------- |
| Routing primitives       | `packages/routing`  | 8      | 104     |
| Orchestrator integration | `apps/orchestrator` | 10     | 130     |
| **Total**                |                     | **18** | **234** |

---

## packages/routing (104 tests)

### RIB Core — `tests/v2/rib/rib.test.ts` (66 tests)

The RIB (Routing Information Base) is the pure-function state machine at the heart of
the routing system. All tests use `plan()` directly — no I/O, no timers, fully deterministic.

#### Peer lifecycle (9 tests)

| Test                                                                                     | Validates                    |
| ---------------------------------------------------------------------------------------- | ---------------------------- |
| LocalPeerCreate adds peer with initializing status and default holdTime                  | Peer creation with defaults  |
| LocalPeerCreate with duplicate name → no state change (prevState === newState)           | Idempotent create            |
| LocalPeerUpdate modifies existing peer fields                                            | Field mutation               |
| LocalPeerUpdate preserves runtime-only fields (connectionStatus, holdTime, lastReceived) | Runtime field isolation      |
| LocalPeerUpdate with unknown peer → no state change                                      | Unknown peer rejection       |
| LocalPeerDelete removes peer from list                                                   | Peer removal                 |
| LocalPeerDelete removes all routes from that peer                                        | Cascade route cleanup        |
| LocalPeerDelete generates port release ops for routes with envoyPort                     | Envoy port release on delete |
| LocalPeerDelete with unknown peer → no state change                                      | Unknown peer rejection       |

#### Route lifecycle (7 tests)

| Test                                                              | Validates               |
| ----------------------------------------------------------------- | ----------------------- |
| LocalRouteCreate adds route to local.routes                       | Route installation      |
| LocalRouteCreate emits added routeChange                          | Change tracking         |
| LocalRouteCreate with duplicate name → no state change            | Idempotent create       |
| LocalRouteDelete removes route from local.routes                  | Route removal           |
| LocalRouteDelete generates port release op if route has envoyPort | Envoy port release      |
| LocalRouteDelete does not generate portOps when no envoyPort      | No spurious port ops    |
| LocalRouteDelete with unknown route → no state change             | Unknown route rejection |

#### BGP propagation via InternalProtocolUpdate (11 tests)

| Test                                                              | Validates                         |
| ----------------------------------------------------------------- | --------------------------------- |
| 'add' stores route with correct peer, nodePath, originNode        | Route attribute preservation      |
| 'add' with loop (nodeId in nodePath) → skipped, no route added    | Loop detection                    |
| 'remove' deletes route by (name, originNode)                      | Withdrawal processing             |
| 'remove' generates release portOp for route with envoyPort        | Port cleanup on withdrawal        |
| resets lastReceived on sending peer                               | Hold timer refresh                |
| 'add' with shorter path replaces existing (best-path selection)   | Shortest-path preference          |
| 'add' with longer path does NOT replace existing                  | Longer-path rejection             |
| handles batch update with many routes in a single message         | Bulk route processing (15 routes) |
| batch update with mixed adds and removes processes all operations | Mixed add/remove batch (10 ops)   |
| batch update skips looped routes while processing valid ones      | Selective loop filtering in batch |
| 'add' replaces stale route regardless of path length              | Stale route replacement           |

#### Peer connection (14 tests)

| Test                                                                             | Validates                             |
| -------------------------------------------------------------------------------- | ------------------------------------- |
| InternalProtocolOpen with unknown peer → no state change                         | Unknown peer guard                    |
| InternalProtocolOpen sets connectionStatus to connected and updates lastReceived | Connection establishment              |
| InternalProtocolOpen negotiates holdTime as min of local and remote              | Hold time negotiation (lower remote)  |
| InternalProtocolOpen keeps local holdTime when remote offers higher              | Hold time negotiation (higher remote) |
| InternalProtocolOpen with no holdTime keeps local holdTime                       | Missing hold time fallback            |
| InternalProtocolConnected sets connected status, lastConnected, and lastReceived | Outbound connection tracking          |
| InternalProtocolConnected with unknown peer → no state change                    | Unknown peer guard                    |
| InternalProtocolClose with NORMAL code removes routes                            | Clean shutdown cleanup                |
| InternalProtocolClose with TRANSPORT_ERROR marks routes isStale=true             | Graceful restart (stale marking)      |
| InternalProtocolClose with HOLD_EXPIRED removes routes                           | Hold timer expiry cleanup             |
| InternalProtocolClose with ADMIN_SHUTDOWN removes routes                         | Admin shutdown cleanup                |
| InternalProtocolClose generates port release ops for removed routes              | Port cleanup on close                 |
| InternalProtocolClose with TRANSPORT_ERROR does NOT generate port ops            | No port ops for stale routes          |
| InternalProtocolClose with unknown peer → no state change                        | Unknown peer guard                    |

#### Tick / hold timer (8 tests)

| Test                                                                   | Validates                      |
| ---------------------------------------------------------------------- | ------------------------------ |
| Tick with no expired peers → prevState === newState (reference equal)  | No-op tick optimization        |
| Tick expires peer past holdTime → removes routes and marks peer closed | Hold timer expiry              |
| Tick generates port release ops for expired peer routes                | Port cleanup on expiry         |
| Tick ignores peers with holdTime === 0                                 | Disabled hold timer            |
| Tick ignores peers with lastReceived === 0 (never received anything)   | Pre-connection peer skip       |
| Tick ignores closed peers with no stale routes (normal close)          | Disconnected peer skip         |
| Tick purges stale routes from closed peers after holdTime grace period | Stale route expiry after grace |
| Tick releases envoy ports when purging stale routes                    | Port cleanup on stale purge    |

#### Keepalive (3 tests)

| Test                                                          | Validates                   |
| ------------------------------------------------------------- | --------------------------- |
| InternalProtocolKeepalive updates lastReceived on peer        | Keepalive timestamp refresh |
| InternalProtocolKeepalive with unknown peer → no state change | Unknown peer guard          |
| InternalProtocolKeepalive resets hold timer to prevent expiry | Keepalive prevents expiry   |

#### Plan purity (5 tests)

| Test                                                       | Validates                     |
| ---------------------------------------------------------- | ----------------------------- |
| plan() does not mutate input state                         | Immutability guarantee        |
| plan() with same inputs produces same structural output    | Determinism                   |
| rejected action: prevState === newState reference equality | Reference equality for no-ops |
| stateChanged() returns false when prevState === newState   | Change detection (negative)   |
| stateChanged() returns true when state changed             | Change detection (positive)   |

#### Journal integration (6 tests)

| Test                                                                        | Validates                 |
| --------------------------------------------------------------------------- | ------------------------- |
| commit() with InMemoryActionLog appends when state changed                  | Journal append on change  |
| commit() does NOT append to journal when state unchanged                    | No journal for no-ops     |
| state rebuilt from journal replay matches live state after multiple actions | Replay fidelity           |
| commit() appends the correct nodeId to journal entries                      | Node attribution          |
| commit() does not journal duplicate actions                                 | Dedup on journal          |
| commit() updates internal state regardless of journal                       | State update independence |

#### Multi-peer scenarios (2 tests)

| Test                                                    | Validates            |
| ------------------------------------------------------- | -------------------- |
| routes from different peers coexist independently       | Cross-peer isolation |
| LocalPeerDelete does not affect routes from other peers | Selective cleanup    |

#### Initial state (1 test)

| Test                                              | Validates                  |
| ------------------------------------------------- | -------------------------- |
| uses provided initialState instead of empty table | State injection for replay |

### ActionQueue — `tests/v2/rib/action-queue.test.ts` (3 tests)

| Test                                               | Validates                 |
| -------------------------------------------------- | ------------------------- |
| executes operations sequentially                   | Serialized dispatch       |
| propagates errors to caller without blocking queue | Error isolation           |
| returns values from enqueued operations            | Return value pass-through |

### Schema — `tests/v2/schema.test.ts` (12 tests)

| Test                                          | Validates                   |
| --------------------------------------------- | --------------------------- |
| rejects update with missing nodePath          | Required field enforcement  |
| rejects update with empty nodePath            | Non-empty array enforcement |
| accepts update with nodePath and originNode   | Valid schema acceptance     |
| rejects update with missing originNode        | Required field enforcement  |
| rejects updates array exceeding 1000 entries  | Batch size limit            |
| accepts updates array at exactly 1000 entries | Boundary acceptance         |
| parses valid keepalive                        | Keepalive schema            |
| rejects wrong action type                     | Action discriminator        |
| parses without holdTime (optional)            | Optional holdTime           |
| parses with holdTime                          | HoldTime presence           |
| parses keepalive through unified schema       | Union dispatch              |
| parses all v1 action types                    | Backward compatibility      |

### Journal — `tests/v2/journal/` (18 tests)

#### InMemoryActionLog — `in-memory-action-log.test.ts` (7 tests)

| Test                                   | Validates             |
| -------------------------------------- | --------------------- |
| returns incrementing sequence numbers  | Sequence monotonicity |
| replays all actions in order           | Full replay           |
| replays actions after given seq        | Partial replay        |
| returns empty array on empty log       | Empty state           |
| returns 0 for lastSeq on empty log     | Default seq           |
| returns highest seq after appends      | Seq tracking          |
| stores multiple action types correctly | Type discrimination   |

#### SqliteActionLog — `sqlite-action-log.test.ts` (11 tests)

| Test                                   | Validates              |
| -------------------------------------- | ---------------------- |
| creates table on construction          | DDL auto-creation      |
| returns incrementing sequence numbers  | Sequence monotonicity  |
| replays all actions in order           | Full replay            |
| replays actions after given seq        | Partial replay         |
| returns empty array on empty log       | Empty state            |
| returns 0 for lastSeq on empty log     | Default seq            |
| returns highest seq after appends      | Seq tracking           |
| round-trips action data through JSON   | Serialization fidelity |
| stores action type in separate column  | Indexed column         |
| stores multiple action types correctly | Type discrimination    |
| has timestamp on entries               | Audit timestamp        |

### Route Policy — `tests/v2/route-policy.test.ts` (2 tests)

| Test                                 | Validates            |
| ------------------------------------ | -------------------- |
| returns all routes (pass-through)    | Default policy       |
| returns empty array for empty routes | Empty input handling |

### Close Codes — `tests/v2/close-codes.test.ts` (2 tests)

| Test                       | Validates      |
| -------------------------- | -------------- |
| has correct numeric values | Code constants |
| has exactly 5 codes        | Exhaustiveness |

### DataChannel — `tests/v2/datachannel.test.ts` (1 test)

| Test                        | Validates      |
| --------------------------- | -------------- |
| routeKey returns route name | Key derivation |

---

## apps/orchestrator (130 tests)

### OrchestratorBus — `tests/v2/bus.test.ts` (6 tests)

The bus wires RIB dispatch to journal, post-commit hooks, and peer transport.

| Test                                                     | Validates                 |
| -------------------------------------------------------- | ------------------------- |
| dispatches LocalRouteCreate and installs route           | End-to-end local route    |
| dispatches LocalRouteDelete and removes route            | End-to-end local delete   |
| dispatches LocalPeerCreate and adds peer                 | End-to-end peer create    |
| emits plan on successful dispatch                        | Plan event emission       |
| does not emit plan when state unchanged                  | No-op suppression         |
| dispatch serializes concurrent calls via ActionQueue     | Concurrency safety        |
| getState returns current RIB state                       | State accessor            |
| onPlan callback receives routeChanges                    | Change notification       |
| stop() prevents further dispatches                       | Lifecycle shutdown        |
| stop() rejects in-flight dispatches                      | Graceful stop             |
| dispatches InternalProtocolUpdate (route add from peer)  | Peer route propagation    |
| dispatches InternalProtocolClose and removes peer routes | Close cleanup             |
| dispatches Tick action through bus                       | Timer integration         |
| replays journal on construction                          | Journal replay on startup |
| handles plan with portOps                                | Port operation forwarding |

### Tick Manager — `tests/v2/tick-manager.test.ts` (15 tests)

| Test                                                       | Validates           |
| ---------------------------------------------------------- | ------------------- |
| calls dispatch with Tick action at interval                | Periodic dispatch   |
| stop() clears interval                                     | Cleanup             |
| uses configurable interval                                 | Custom interval     |
| start() is idempotent (does not create multiple intervals) | Double-start safety |
| stop() is idempotent                                       | Double-stop safety  |
| includes current timestamp in tick data                    | Clock injection     |
| does not throw if dispatch rejects                         | Error resilience    |
| tick continues after dispatch error                        | Fault tolerance     |

### Journal Replay — `tests/v2/journal-replay.test.ts` (8 tests)

| Test                                   | Validates           |
| -------------------------------------- | ------------------- |
| empty journal produces initial state   | Empty replay        |
| replays LocalRouteCreate actions       | Route replay        |
| replays LocalPeerCreate actions        | Peer replay         |
| replays InternalProtocolUpdate actions | Protocol replay     |
| replays mixed action sequence          | Multi-action replay |
| replay matches live dispatch state     | Fidelity guarantee  |
| replays from specific sequence number  | Partial replay      |

### Graceful Restart — `tests/v2/graceful-restart.topology.test.ts` (6 tests)

| Test                                                              | Validates            |
| ----------------------------------------------------------------- | -------------------- |
| TRANSPORT_ERROR marks routes stale instead of removing            | Stale marking        |
| stale routes are replaced when peer reconnects with fresh routes  | Stale replacement    |
| stale routes survive Tick if peer reconnects in time              | Hold timer tolerance |
| stale routes are cleaned up after hold timer expires              | Stale expiry         |
| non-stale routes from other peers unaffected                      | Cross-peer isolation |
| reconnecting peer with empty routes clears stale routes           | Empty update cleanup |
| multiple peers can be in stale state simultaneously               | Multi-peer stale     |
| stale routes do not appear in routeChanges until actually removed | Change suppression   |
| NORMAL close removes routes immediately (no stale)                | Clean close contrast |
| ADMIN_SHUTDOWN removes routes immediately (no stale)              | Admin close contrast |

### Keepalive — `tests/v2/keepalive.topology.test.ts` (12 tests)

| Test                                         | Validates             |
| -------------------------------------------- | --------------------- |
| keepalive updates lastReceived timestamp     | Timestamp refresh     |
| keepalive prevents hold timer expiry         | Expiry prevention     |
| missing keepalive causes hold timer expiry   | Expiry on timeout     |
| keepalive with unknown peer is no-op         | Unknown peer guard    |
| hold timer negotiation uses minimum          | Min negotiation       |
| zero holdTime disables expiry checking       | Disabled hold timer   |
| peer with lastReceived=0 not expired by tick | Pre-connection safety |
| disconnected peer not expired by tick        | Disconnected skip     |
| keepalive only updates target peer           | Peer isolation        |

### Post-Commit Hooks — `tests/v2/post-commit.test.ts` (16 tests)

| Test                                            | Validates                |
| ----------------------------------------------- | ------------------------ |
| notifies connected peers of route additions     | Peer notification        |
| notifies connected peers of route removals      | Withdrawal notification  |
| does not notify the source peer (split-horizon) | Split-horizon rule       |
| does not notify disconnected peers              | Status-based filtering   |
| includes full routeTable in update message      | Full table sync          |
| sends correct nodePath (prepends local nodeId)  | Path prepend             |
| handles multiple connected peers                | Multi-peer fan-out       |
| skips notification when no route changes        | No-change suppression    |
| sends keepalive to connected peers on tick      | Keepalive dispatch       |
| does not send keepalive to disconnected peers   | Status filtering         |
| handles peer send errors gracefully             | Error resilience         |
| sends withdrawal for removed routes             | Explicit withdrawal      |
| handles empty peer list                         | Empty peer guard         |
| executes portOps from plan                      | Port operation execution |

### Orchestrator Topology — `tests/v2/orchestrator.topology.test.ts` (11 tests)

Multi-node topology tests exercising the full dispatch pipeline with MockPeerTransport.

| Test                                               | Validates                   |
| -------------------------------------------------- | --------------------------- |
| two nodes exchange routes after peering            | Basic peering               |
| routes propagate through three-node chain (A→B→C)  | Multi-hop transit           |
| loop detection prevents re-advertisement to origin | Path-vector loop prevention |
| route withdrawal propagates through chain          | Withdrawal propagation      |
| node with multiple peers fans out routes           | Fan-out topology            |
| late-joining node receives existing routes         | Late join sync              |
| peer disconnect removes routes on remote side      | Disconnect cleanup          |
| local route deletion propagates withdrawal         | Local delete propagation    |
| simultaneous route additions from multiple peers   | Concurrent adds             |
| route update (add then remove then re-add)         | Route flap handling         |
| three-node triangle does not loop                  | Triangle loop prevention    |
| four-node full mesh converges                      | Full mesh convergence       |
| routes carry correct originNode through chain      | Origin attribution          |
| nodePath grows at each hop                         | Path accumulation           |
| best-path selection prefers shorter path           | Shortest-path preference    |
| split-horizon prevents sending back to source      | Split-horizon enforcement   |

### Service Integration — `tests/v2/service.test.ts` (8 tests)

Tests the OrchestratorService wiring (bus + tick manager + RPC lifecycle).

| Test                                      | Validates          |
| ----------------------------------------- | ------------------ |
| starts and initializes bus                | Startup lifecycle  |
| registers local routes on start           | Auto-registration  |
| stops cleanly                             | Shutdown lifecycle |
| creates peer and dispatches to bus        | Peer management    |
| handles peer connection events            | Connection wiring  |
| handles peer disconnection                | Disconnect wiring  |
| handles incoming route updates from peers | Inbound protocol   |
| handles incoming keepalive from peers     | Keepalive wiring   |
| rejects update from unregistered peer     | Auth boundary      |
| tick manager starts on service start      | Timer auto-start   |
| tick manager stops on service stop        | Timer auto-stop    |
| getState returns current routing state    | State accessor     |

### Reconnection — `tests/v2/reconnect.test.ts` (16 tests)

| Test                                         | Validates             |
| -------------------------------------------- | --------------------- |
| reconnects after transport error             | Auto-reconnect        |
| uses exponential backoff                     | Backoff timing        |
| caps backoff at maxDelay                     | Max delay ceiling     |
| resets backoff after successful connection   | Backoff reset         |
| stops reconnecting after maxAttempts         | Attempt limit         |
| stops reconnecting when stop() called        | Manual stop           |
| does not reconnect on normal close           | Clean close skip      |
| does not reconnect on admin shutdown         | Admin close skip      |
| reconnects on hold timer expiry              | Hold expiry reconnect |
| concurrent reconnect attempts are serialized | Concurrency safety    |
| reconnect restores routes from peer          | Route restoration     |
| reconnect does not duplicate peers           | Peer dedup            |
| handles connection failure during reconnect  | Failure resilience    |
| emits reconnecting event                     | Event notification    |
| emits reconnected event on success           | Success notification  |
| emits reconnectFailed event on max attempts  | Failure notification  |
| respects jitter in backoff                   | Jitter randomization  |
| custom shouldReconnect predicate             | Custom policy         |

### RPC — `tests/v2/rpc.test.ts` (32 tests)

Tests the capnweb RPC interface (PublicApi + IBGPClient factories).

| Test                                                      | Validates              |
| --------------------------------------------------------- | ---------------------- |
| creates PublicApi RPC session                             | Session creation       |
| registerService adds local route                          | Service registration   |
| unregisterService removes local route                     | Service deregistration |
| getRoutes returns current route table                     | Route query            |
| getRoutes returns routes from multiple sources            | Multi-source query     |
| rejects registerService without valid token               | Auth enforcement       |
| rejects unregisterService without valid token             | Auth enforcement       |
| allows getRoutes without token (read-only)                | Public read access     |
| creates IBGPClient RPC session                            | Session creation       |
| IBGPClient.open dispatches InternalProtocolOpen           | Protocol dispatch      |
| IBGPClient.update dispatches InternalProtocolUpdate       | Update dispatch        |
| IBGPClient.close dispatches InternalProtocolClose         | Close dispatch         |
| IBGPClient.keepalive dispatches InternalProtocolKeepalive | Keepalive dispatch     |
| rejects IBGPClient methods without valid token            | Auth enforcement       |
| IBGPClient validates peer identity matches token          | Identity binding       |
| PublicApi registerService validates route schema          | Schema enforcement     |
| IBGPClient update validates message schema                | Schema enforcement     |
| concurrent RPC calls are serialized through bus           | Concurrency safety     |
| RPC session cleanup on WebSocket close                    | Resource cleanup       |
| IBGPClient open includes holdTime in negotiation          | Hold time parameter    |
| PublicApi getNodeInfo returns node metadata               | Metadata query         |

---

## Test Architecture

### Principles

1. **Pure plan() for unit tests** — RIB tests call `plan()` directly, asserting on
   `{ prevState, newState, routeChanges, portOps }` without I/O.
2. **MockPeerTransport for integration** — topology tests wire multiple OrchestratorBus
   instances through in-memory transports, validating multi-hop convergence.
3. **Deterministic time** — Tick and keepalive tests inject `now` timestamps rather than
   using wall clocks, eliminating flakiness.
4. **Journal replay as invariant** — several tests verify that replaying the action log
   from empty state reproduces the same routing table as live dispatch.

### Running

```bash
# All v2 unit tests
pnpm exec vitest run packages/routing/tests/v2/
pnpm exec vitest run apps/orchestrator/tests/v2/

# Single file
pnpm exec vitest run packages/routing/tests/v2/rib/rib.test.ts

# Via turbo (what CI runs)
pnpm exec turbo run test:unit
```
