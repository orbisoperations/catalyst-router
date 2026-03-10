# V2 Orchestrator Capabilities Catalog

Exhaustive catalog of the v2 orchestrator's features, behaviors, and public APIs. For easy v1↔v2 comparison, organized by the same categories.

**Last updated:** 2026-03-10
**Scope:** v2 implementation starting with RoutingInformationBase, OrchestratorBus, OrchestratorServiceV2, and WebSocketPeerTransport.

---

## 1. State Management

### Dispatch Pipeline

**Feature:** Action-driven dispatch with serialized queue.

**Location:** `apps/orchestrator/src/v2/bus.ts:115–132` (OrchestratorBus.dispatch)

**Description:**
- Accepts an `Action` object and serializes it through an `ActionQueue` to prevent concurrent mutation.
- Pure `plan()` phase computes what would change (PlanResult with prevState, newState, portOps, routeChanges).
- `commit()` phase applies state + journals if state changed.
- Returns `StateResult` with success flag, state snapshot, or error.

**Dependencies:**
- `@catalyst/routing/v2` RoutingInformationBase, ActionQueue, Actions, Action types
- ActionLog (optional journaling)

**Public API Surface:**
```typescript
async dispatch(action: Action): Promise<StateResult>
  // StateResult: { success: true; state: RouteTable; action: Action } |
  //             { success: false; error: string; state?: RouteTable }
```

### Plan/Commit Purity

**Feature:** Strict separation of pure planning from side-effect commit.

**Location:**
- `packages/routing/src/v2/rib/rib.ts:96–123` (plan method)
- `packages/routing/src/v2/rib/rib.ts:132–138` (commit method)

**Description:**
- `plan(action, state)` is a pure function — never mutates inputs, always returns new RouteTable by value (or same reference for no-op).
- `commit(plan, action)` has all side effects: replaces internal _state, appends to journal if state changed.
- Callers detect real state change via reference equality: `plan.prevState !== plan.newState`.
- Enables replay, testing, and deterministic behavior.

**Dependencies:** None (pure computation)

**Public API Surface:**
```typescript
plan(action: Action, state: RouteTable): PlanResult
  // Returns { prevState, newState, portOps, routeChanges }

commit(plan: PlanResult, action: Action): RouteTable
  // Returns new internal state snapshot

stateChanged(plan: PlanResult): boolean
  // Reference equality check
```

### Action Queue

**Feature:** Serializes async operations to prevent TOCTOU race conditions.

**Location:** `packages/routing/src/v2/rib/action-queue.ts`

**Description:**
- Each dispatch() call enqueues an async task that waits for the previous task to complete before starting.
- Errors in one operation do not block subsequent operations.
- Prevents concurrent mutation of shared state.

**Dependencies:** None (Promise-based)

**Public API Surface:**
```typescript
class ActionQueue {
  enqueue<T>(fn: () => Promise<T>): Promise<T>
}
```

### Journal

**Feature:** Append-only action log for replay and auditability.

**Location:**
- `packages/routing/src/v2/journal/action-log.ts` (interface)
- `apps/orchestrator/src/v2/service.ts:52–69` (journal replay on startup)

**Description:**
- All state-changing actions are recorded to journal after commit (if state changed).
- On startup, journal is replayed via temporary RIB to reconstruct last-known route table.
- Supports SQLite-backed (persistent) or in-memory journals.
- Entries include seq, action, nodeId, recorded_at.

**Dependencies:**
- `@catalyst/routing/v2` ActionLog interface
- `better-sqlite3` (for SQLite backend)

**Public API Surface:**
```typescript
interface ActionLog {
  append(action: Action, nodeId: string): number   // Returns seq
  replay(afterSeq?: number): ActionLogEntry[]      // Sequence-ordered
  lastSeq(): number
}
```

### RouteTable Schema

**Feature:** Complete routing state snapshot (local routes + internal peers/routes).

**Location:** `packages/routing/src/v2/state.ts:27–42`

**Description:**
RouteTable shape:
```typescript
type RouteTable = {
  local: {
    routes: DataChannelDefinition[]
  }
  internal: {
    peers: PeerRecord[]
    routes: InternalRoute[]
  }
}
```

PeerRecord fields:
- `name`, `domains`, `endpoint` (from PeerInfo)
- `connectionStatus` ('initializing' | 'connected' | 'closed')
- `lastConnected` (timestamp of last successful open)
- `holdTime` (negotiated, default 90s)
- `lastSent`, `lastReceived` (timestamps for hold-timer tracking)
- `peerToken` (JWT for outbound iBGP auth, not exposed to RPC)

InternalRoute fields:
- All DataChannelDefinition fields (name, protocol, endpoint, region, tags, envoyPort)
- `peer` (PeerInfo)
- `nodePath` (route attribution chain, [originNode, ...hops])
- `originNode` (originating node name)
- `isStale?` (graceful-restart marking after transport error)

**Dependencies:** `@catalyst/config` NodeConfigSchema (for PeerInfo)

**Public API Surface:**
```typescript
type RouteTable = { local: { routes: DataChannelDefinition[] }; internal: { peers: PeerRecord[]; routes: InternalRoute[] } }
function newRouteTable(): RouteTable  // Factory
```

---

## 2. Peer Management

### Peer Lifecycle

**Feature:** Peer create/update/delete with connection status tracking.

**Location:** `packages/routing/src/v2/rib/rib.ts:152–195` (handlers)

**Description:**

**LocalPeerCreate:**
- Adds a peer to internal.peers with connectionStatus='initializing'.
- Default holdTime=90s, lastSent=0, lastReceived=0.
- No-op if peer already exists.
- No route changes, no port operations.

**LocalPeerUpdate:**
- Updates peer's static fields (name, domains, endpoint) while preserving runtime state (connectionStatus, holdTime, lastSent/Received).
- No-op if peer not found.

**LocalPeerDelete:**
- Removes peer and all associated internal routes.
- Marks routes as 'removed' in routeChanges (triggers downstream notifications and port releases).
- Returns portOps for releasing envoyPort on routes that had allocated ports.

**Dependencies:** None

**Public API Surface:**
```typescript
action: Actions.LocalPeerCreate
data: PeerInfo

action: Actions.LocalPeerUpdate
data: PeerInfo

action: Actions.LocalPeerDelete
data: { name: string }
```

### Connection Status Transitions

**Feature:** Tracks peer connection lifecycle (initializing → connected → closed).

**Location:** `packages/routing/src/v2/rib/rib.ts:266–313` (Open/Connected handlers)

**Description:**

**InternalProtocolOpen:**
- Peer transitions initializing → connected.
- Negotiates holdTime: min(peer.holdTime, offer.holdTime).
- Sets lastReceived=now.
- Triggered when peer's iBGP OPEN message arrives (via open() RPC).

**InternalProtocolConnected:**
- Resets holdTime to default (90s) for re-negotiation on reconnect.
- Sets lastConnected=now, lastReceived=now, lastSent=0.
- Triggered after outbound dial succeeds (via reconnect manager or external event).

**InternalProtocolClose:**
- Peer → 'closed' status.
- If close code is TRANSPORT_ERROR: marks all peer routes isStale=true, routes emit 'updated' changes (graceful restart).
- If close code is normal/hold-expired/admin-shutdown/protocol-error: withdraws routes immediately, emits 'removed' changes, releases ports.
- Triggered by transport failure (reconnect manager) or explicit close RPC.

**Dependencies:** CloseCodes enum for code interpretation

**Public API Surface:**
```typescript
action: Actions.InternalProtocolOpen
data: { peerInfo: PeerInfo; holdTime?: number }

action: Actions.InternalProtocolConnected
data: { peerInfo: PeerInfo }

action: Actions.InternalProtocolClose
data: { peerInfo: PeerInfo; code: number; reason?: string }
```

### Peer State Access

**Feature:** RPC clients can list peers without exposing peerToken.

**Location:** `apps/orchestrator/src/v2/rpc.ts:107–109` (NetworkClient.listPeers)

**Description:**
- Returns internal.peers array with peerToken field stripped.
- Accessible via NetworkClient RPC after PEER_CREATE authorization check.

**Dependencies:** None

**Public API Surface:**
```typescript
// Via RPC NetworkClient
async listPeers(): Promise<PeerRecord[]>  // peerToken filtered out
```

---

## 3. Route Management

### Local Route CRUD

**Feature:** Create/delete local (originated) routes.

**Location:** `packages/routing/src/v2/rib/rib.ts:224–260` (handlers)

**Description:**

**LocalRouteCreate:**
- Adds route to local.routes.
- Emits 'added' route change (triggers BGP notify, gateway sync, envoy sync).
- No-op if route name already exists.
- No port operations (ports allocated on-demand during envoy sync).

**LocalRouteDelete:**
- Removes route from local.routes.
- Emits 'removed' route change.
- Releases envoyPort if route had one (portOp: 'release').
- No-op if route not found.

**Dependencies:** routeKey function for route identity

**Public API Surface:**
```typescript
action: Actions.LocalRouteCreate
data: DataChannelDefinition  // { name, protocol, endpoint?, region?, tags?, envoyPort? }

action: Actions.LocalRouteDelete
data: DataChannelDefinition  // Matched by name
```

### Route State Access

**Feature:** RPC clients can list local and internal routes with peer tokens filtered.

**Location:** `apps/orchestrator/src/v2/rpc.ts:140–148` (DataChannel.listRoutes)

**Description:**
- Returns { local: [], internal: [] } with peer.peerToken stripped from internal routes.
- Accessible via DataChannelClient RPC after ROUTE_CREATE authorization check.

**Dependencies:** None

**Public API Surface:**
```typescript
// Via RPC DataChannel
async listRoutes(): Promise<{
  local: DataChannelDefinition[]
  internal: InternalRoute[]  // peer.peerToken filtered
}>
```

### DataChannel Schema

**Feature:** Route definition with protocol, endpoint, region, tags, and envoy port.

**Location:** `packages/routing/src/v2/datachannel.ts`

**Description:**
- `name` (1–253 chars, alphanumeric + . _ -, case-insensitive)
- `protocol` (enum: 'http' | 'http:graphql' | 'http:gql' | 'http:grpc' | 'tcp')
- `endpoint` (optional URL, max 2048 chars)
- `region` (optional string)
- `tags` (optional array, max 32 items)
- `envoyPort` (optional integer, managed externally by port allocator)
- Route identity key: currently name-only (future: compound with protocol)

**Dependencies:** Zod schema validation

**Public API Surface:**
```typescript
type DataChannelDefinition = {
  name: string
  protocol: DataChannelProtocol
  endpoint?: string
  region?: string
  tags?: string[]
  envoyPort?: number
}

function routeKey(route: Pick<DataChannelDefinition, 'name'>): string
```

---

## 4. BGP Protocol

### Initial Full-Table Sync

**Feature:** When a peer connects, send all known routes (local + internal with filtering).

**Location:** `apps/orchestrator/src/v2/bus.ts:293–337` (syncRoutesToPeer)

**Description:**
- Triggered on InternalProtocolConnected action.
- Advertises all local.routes with nodePath=[this.config.node.name], originNode=this.config.node.name.
- Advertises internal.routes with filtering:
  - Skip stale routes (isStale=true) — may not be valid.
  - Skip routes from the same peer (no reflection).
  - Loop guard: skip if route.nodePath.includes(peer.name).
  - Apply route policy if configured.
- Builds UpdateMessage with 'add' actions, sends via transport.
- Fire-and-forget: failed initial sync is not fatal.

**Dependencies:** RoutePolicy, PeerTransport

**Public API Surface:**
- Automatic on InternalProtocolConnected
- Via UpdateMessage schema (see internal protocol section)

### Delta Propagation (Fan-Out)

**Feature:** When routes change, send deltas to all connected peers with filtering and loop detection.

**Location:** `apps/orchestrator/src/v2/bus.ts:371–414` (buildUpdatesForPeer)

**Description:**
- Triggered post-commit when plan.routeChanges.length > 0.
- For each connected peer:
  - For each route change (added/removed/updated):
    - If internal route (has peer+nodePath):
      - Skip if source peer (no reflection).
      - Skip if nodePath includes target peer (loop guard).
      - Apply route policy for non-removal changes.
    - Build UpdateMessage with action 'add' or 'remove'.
    - Convert InternalRoute to DataChannelDefinition (strip peer/nodePath/originNode/isStale).
- Send updates via transport.sendUpdate().
- Fire-and-forget: one peer failure doesn't affect others.

**Dependencies:** RoutePolicy, PeerTransport, BusTransforms helper

**Public API Surface:**
- Automatic on route changes (plan.routeChanges)
- Via UpdateMessage schema

### Update Message Schema

**Feature:** Wire format for route advertisements/withdrawals.

**Location:** `packages/routing/src/v2/internal/actions.ts:26–37` (UpdateMessageSchema)

**Description:**
```typescript
type UpdateMessage = {
  updates: Array<{
    action: 'add' | 'remove'
    route: DataChannelDefinition
    nodePath: string[]  // [originNode, ...hops], min 1, max 64 hops
    originNode: string  // Origin node name, max 253 chars
  }>
}
```
- Max 1000 updates per message.
- nodePath enforces attribution chain for loop detection and origin tracking.
- All route updates carry full path metadata.

**Dependencies:** DataChannelDefinition schema

**Public API Surface:**
```typescript
export const UpdateMessageSchema: z.ZodSchema<UpdateMessage>
```

### Internal Protocol Update Handler

**Feature:** Process incoming iBGP updates from a peer.

**Location:** `packages/routing/src/v2/rib/rib.ts:362–435` (planInternalProtocolUpdate)

**Description:**
- Updates lastReceived timestamp on peer (even if no routes changed).
- For each update in the message:
  - **Add:**
    - Loop detection: skip if nodePath.includes(this._nodeId).
    - Best-path selection: prefer shorter nodePath, or replace stale routes.
    - If route exists: update only if better path or replacing stale, emit 'updated' change.
    - If new route: add to internal.routes, emit 'added' change.
  - **Remove:**
    - Find route by routeKey + originNode match.
    - Remove if found, emit 'removed' change, release envoyPort if present.
- No-op if no routes changed and peer unknown.
- Returns PlanResult with all route changes.

**Dependencies:** routeKey function, stale marking logic

**Public API Surface:**
```typescript
action: Actions.InternalProtocolUpdate
data: {
  peerInfo: PeerInfo
  update: UpdateMessage
}
```

### Best-Path Selection

**Feature:** Prefer routes with shorter nodePath, or replace stale routes.

**Location:** `packages/routing/src/v2/rib/rib.ts:390–397`

**Description:**
- When a new route advertisement arrives for an existing route (same routeKey + originNode):
  - Prefer new route if nodePath.length < existing.nodePath.length.
  - Prefer new route if existing.isStale === true (any fresh route wins).
  - Otherwise keep existing route (path is equal or better and fresh).
- Ties broken by "keep existing" (first-arrive-first-served within same path length).

**Dependencies:** None (local comparison logic)

**Public API Surface:**
- Automatic in planInternalProtocolUpdate

### Loop Detection

**Feature:** Prevent routes from passing through a node twice.

**Location:**
- `packages/routing/src/v2/rib/rib.ts:373` (update handler: skip if nodePath.includes(nodeId))
- `apps/orchestrator/src/v2/bus.ts:388` (delta fan-out: skip if nodePath.includes(peer.name))

**Description:**
- On incoming update: discard advertised route if this.nodeId is already in nodePath.
- On fan-out: skip sending a route to a peer if that peer is already in the route's nodePath.
- Enforced at max 64 hops per message schema.
- Complements split-horizon filtering.

**Dependencies:** None

**Public API Surface:**
- Automatic in planInternalProtocolUpdate and buildUpdatesForPeer

### Split-Horizon Filtering

**Feature:** Don't send a peer its own routes back.

**Location:**
- `apps/orchestrator/src/v2/bus.ts:310–311` (initial sync: skip if route.peer.name === peer.name)
- `apps/orchestrator/src/v2/bus.ts:385–386` (delta: skip if route.peer.name === peer.name)

**Description:**
- In initial sync and delta propagation, skip any internal route if the originating peer matches the target peer.
- Prevents route reflection that could create unintended routing loops.

**Dependencies:** None

**Public API Surface:**
- Automatic in syncRoutesToPeer and buildUpdatesForPeer

### Route Policy

**Feature:** Per-peer route filtering (hooks for future Cedar policy evaluation).

**Location:** `packages/routing/src/v2/route-policy.ts`

**Description:**
- RoutePolicy interface: `canSend(peer, routes): InternalRoute[]`.
- Current implementation: ConfigurableRoutePolicy (pass-through, sends all routes).
- Called in initial sync (after loop guard) and delta fan-out (for non-removal changes only).
- No-op if policy undefined.
- Future M3 (External Peering): backed by Cedar policy to filter exports between organizations.

**Dependencies:** None (interface only)

**Public API Surface:**
```typescript
interface RoutePolicy {
  canSend(peer: PeerRecord, routes: InternalRoute[]): InternalRoute[]
}

class ConfigurableRoutePolicy implements RoutePolicy {
  canSend(_peer, routes): InternalRoute[]  // Returns routes as-is
}
```

---

## 5. Keepalive / Hold Timer

### Hold Timer Negotiation

**Feature:** Agree on hold timer interval during peer open.

**Location:** `packages/routing/src/v2/rib/rib.ts:272–273` (planInternalProtocolOpen)

**Description:**
- On InternalProtocolOpen, holdTime = min(peer.holdTime, offer.holdTime).
- Peer's local holdTime is set at creation (default 90s, can be updated via LocalPeerUpdate).
- Offer comes from remote peer's open() call (passed as optional holdTime parameter).
- Result is stored in peer record and used for Tick-based hold timer expiry.

**Dependencies:** None

**Public API Surface:**
```typescript
action: Actions.InternalProtocolOpen
data: { peerInfo: PeerInfo; holdTime?: number }  // Optional offer
```

### Tick Action (Periodic Check)

**Feature:** Drive hold timer and stale route cleanup on fixed interval.

**Location:**
- `packages/routing/src/v2/system/actions.ts` (Tick schema)
- `packages/routing/src/v2/rib/rib.ts:458–508` (planTick handler)

**Description:**
- Tick action: `{ action: 'system:tick', data: { now: number } }`.
- Dispatched every N milliseconds (default 30s, recalculated as min(holdTime) / 3).
- Handler checks for:
  1. **Hold timer expiry:** If connected peer, holdTime > 0, lastReceived > 0, and now - lastReceived > holdTime → mark peer 'closed'.
  2. **Stale route purge:** If peer is 'closed', holdTime > 0, and holdTime grace elapsed without reconnect → purge stale routes from that peer.
- Emits 'removed' changes for purged routes, releases ports.
- No-op if no peers expired or stale routes purged.

**Dependencies:** None

**Public API Surface:**
```typescript
action: Actions.Tick
data: { now: number }  // Current timestamp
```

### Keepalive Sending

**Feature:** Send periodic keepalive messages to prevent session expiry.

**Location:** `apps/orchestrator/src/v2/bus.ts:348–365` (handleKeepalives)

**Description:**
- Triggered:
  - On Tick dispatch (both no-op and state-change paths).
  - On keepalive-related routes expiring via Tick.
- Filters connected peers where:
  - connectionStatus='connected'
  - holdTime > 0
  - now - lastKeepaliveSent.get(peer.name) > holdTime / 3
- For each peer needing keepalive:
  - Call transport.sendKeepalive(peer).
  - Update lastKeepaliveSent[peer.name] = now (ephemeral, not journaled).
- Fire-and-forget: keepalive failure is not fatal.
- Ephemeral tracking: lastKeepaliveSent resets to 0 on restart (no persistence).

**Dependencies:** PeerTransport

**Public API Surface:**
- Automatic on Tick
- Via transport.sendKeepalive(peer)

### Keepalive Message Type

**Feature:** Dedicated RPC method for keepalive messages.

**Location:**
- `packages/routing/src/v2/internal/actions.ts:74–83` (InternalProtocolKeepaliveMessageSchema)
- `apps/orchestrator/src/v2/rpc.ts:65–67` (IBGPClient.keepalive signature)

**Description:**
- RPC method: `keepalive(data: { peerInfo: PeerInfo })`.
- Dispatches as action: `{ action: 'internal:protocol:keepalive', data: { peerInfo } }`.
- Handler: updates peer.lastReceived = now.
- No route changes, no port operations.
- Allows explicit keepalive sends (for testing and edge cases) in addition to automatic Tick-driven sends.

**Dependencies:** None

**Public API Surface:**
```typescript
action: Actions.InternalProtocolKeepalive
data: { peerInfo: PeerInfo }

// Via RPC IBGPClient
async keepalive(data: { peerInfo: PeerInfo }): Promise<{ success: true } | { success: false; error: string }>
```

### Tick Manager

**Feature:** Periodic timer dispatch with dynamic interval recalculation.

**Location:** `apps/orchestrator/src/v2/tick-manager.ts`

**Description:**
- Manages a setInterval that fires Tick actions at configurable interval (default 30s).
- `start()`: begins periodic dispatch (idempotent).
- `stop()`: clears interval.
- `recalculate(holdTimes: number[])`: computes newInterval = max(1000ms, floor(min(active holdTimes) / 3)), restarts timer if running and interval changed.
- Public API: currentIntervalMs, isRunning.
- Integrated into OrchestratorServiceV2: recalculated on peer open/connected actions.

**Dependencies:** None (browser-compatible setInterval)

**Public API Surface:**
```typescript
class TickManager {
  start(): void
  stop(): void
  recalculate(holdTimes: number[]): void
  get currentIntervalMs(): number
  get isRunning(): boolean
}
```

### Graceful Restart (Stale Route Marking)

**Feature:** On transport error, mark routes stale instead of withdrawing immediately.

**Location:** `packages/routing/src/v2/rib/rib.ts:323–341` (planInternalProtocolClose)

**Description:**
- When peer closes with code=TRANSPORT_ERROR:
  - Mark all peer's routes isStale=true (instead of removing).
  - Emit 'updated' changes (downstream gets notified).
  - No port releases (ports stay allocated in case of quick reconnect).
- When peer closes with code=NORMAL/HOLD_EXPIRED/ADMIN_SHUTDOWN/PROTOCOL_ERROR:
  - Immediately remove routes.
  - Release ports.
- Stale routes are replaced on reconnect if fresh routes arrive, or purged by Tick if grace period (holdTime) expires.

**Dependencies:** CloseCodes.TRANSPORT_ERROR

**Public API Surface:**
- Automatic in planInternalProtocolClose based on close code

---

## 6. GraphQL Gateway Sync

### Protocol Filtering

**Feature:** Sync only HTTP GraphQL routes to the gateway.

**Location:** `apps/orchestrator/src/v2/bus.ts:206–222` (handleGraphqlGatewaySync)

**Description:**
- Triggered post-commit when plan.routeChanges.length > 0 (if gatewayClient configured).
- Filters all routes (local + internal) where protocol === 'http:graphql' or protocol === 'http:gql'.
- Extracts { name, url: endpoint! } for each GraphQL route.
- Calls gatewayClient.updateConfig({ services: [...] }).
- Fire-and-forget: errors swallowed to avoid disrupting bus.

**Dependencies:** GatewayClient interface, no external library dependency

**Public API Surface:**
- Automatic on route changes
- Via GatewayClient.updateConfig(config)

### Gateway Client

**Feature:** HTTP batch RPC client for pushing service config to gateway.

**Location:** `apps/orchestrator/src/v2/gateway-client.ts`

**Description:**
- Factory function: `createGatewayClient(endpoint: string): GatewayClient`.
- Creates lazy-initialized capnweb HTTP batch RPC session.
- Single method: `updateConfig(config: { services: Array<{ name, url }> }): Promise<GatewayUpdateResult>`.
- Result: `{ success: boolean; error?: string }`.

**Dependencies:** `capnweb` for HTTP batch RPC, lazy stub creation

**Public API Surface:**
```typescript
interface GatewayClient {
  updateConfig(config: {
    services: Array<{ name: string; url: string }>
  }): Promise<GatewayUpdateResult>
}

function createGatewayClient(endpoint: string): GatewayClient
```

### Configuration

**Feature:** Gateway endpoint configured via OrchestratorConfig.

**Location:**
- `apps/orchestrator/src/v2/service.ts:75–77` (gateway creation from config)
- `apps/orchestrator/src/v2/catalyst-service.ts:131` (OrchestratorConfig.gqlGatewayConfig?.endpoint)

**Description:**
- Optional config: `orchestrator.gqlGatewayConfig.endpoint`.
- If omitted, no gateway client created, no gateway sync performed.
- If present, client auto-created and passed to OrchestratorBus.

**Dependencies:** OrchestratorConfig schema

**Public API Surface:**
```typescript
// Via OrchestratorConfig
gqlGatewayConfig?: {
  endpoint: string  // HTTP endpoint for gateway RPC
}
```

---

## 7. Envoy Config Sync

### Port Allocation and Release

**Feature:** Manage dynamic port assignments for local and internal routes via external port allocator.

**Location:** `apps/orchestrator/src/v2/bus.ts:239–287` (handleEnvoySync)

**Description:**
- Triggered post-commit when plan.routeChanges.length > 0 or plan.portOps.length > 0 (if envoyClient + portAllocator configured).
- Four phases:
  1. **Release removed routes:** For each route change with type='removed', release port via allocator (local: route.name, internal: "egress_name_via_peer").
  2. **Release RIB portOps:** For each portOp with type='release', release via allocator.
  3. **Allocate missing local ports:** For each local route without envoyPort, call allocator.allocate(route.name).
  4. **Allocate missing egress ports:** For each internal route, call allocator.allocate("egress_name_via_peer").
- Push complete config to envoy: `envoyClient.updateRoutes({ local, internal, portAllocations })`.
- Fire-and-forget: errors swallowed.

**Dependencies:** BusPortAllocator interface, EnvoyClient interface

**Public API Surface:**
```typescript
interface BusPortAllocator {
  allocate(channelName: string): { success: true; port: number } | { success: false; error: string }
  release(channelName: string): void
  getAllocations(): ReadonlyMap<string, number>
}
```

### Envoy Client

**Feature:** HTTP batch RPC client for pushing routes and port allocations to Envoy service.

**Location:** `apps/orchestrator/src/v2/envoy-client.ts`

**Description:**
- Factory function: `createEnvoyClient(endpoint: string): EnvoyClient`.
- Creates lazy-initialized capnweb HTTP batch RPC session.
- Single method: `updateRoutes(config: { local, internal, portAllocations? }): Promise<EnvoyUpdateResult>`.
- Config includes full route list (not deltas) with port assignments.
- Result: `{ success: boolean; error?: string }`.

**Dependencies:** `capnweb` for HTTP batch RPC

**Public API Surface:**
```typescript
interface EnvoyClient {
  updateRoutes(config: {
    local: DataChannelDefinition[]
    internal: InternalRoute[]
    portAllocations?: Record<string, number>
  }): Promise<EnvoyUpdateResult>
}

function createEnvoyClient(endpoint: string): EnvoyClient
```

### Port Allocator (External)

**Feature:** Manages port pool for routes (implemented by @catalyst/envoy-service).

**Location:** `apps/orchestrator/src/v2/service.ts:83–85` (port allocator creation)

**Description:**
- Factory from @catalyst/envoy-service: `createPortAllocator(portRange: PortRange): BusPortAllocator`.
- allocate(channelName) returns port number or error.
- release(channelName) returns port to pool.
- getAllocations() returns current map of channel → port.
- Allocations are ephemeral (not persisted) — reset on restart.

**Dependencies:** `@catalyst/envoy-service` createPortAllocator

**Public API Surface:**
```typescript
function createPortAllocator(portRange: PortRange): BusPortAllocator
```

### Configuration

**Feature:** Envoy endpoint and port range configured via OrchestratorConfig.

**Location:**
- `apps/orchestrator/src/v2/service.ts:79–85` (envoy creation from config)
- `apps/orchestrator/src/v2/catalyst-service.ts:131` (OrchestratorConfig.envoyConfig)

**Description:**
- Optional config: `orchestrator.envoyConfig.endpoint`, `orchestrator.envoyConfig.portRange`.
- If omitted, no envoy client or port allocator created, no envoy sync performed.
- If present, both created and passed to OrchestratorBus.

**Dependencies:** OrchestratorConfig schema

**Public API Surface:**
```typescript
// Via OrchestratorConfig
envoyConfig?: {
  endpoint: string
  portRange: PortRange
}
```

---

## 8. RPC Server

### Exposed Endpoints

**Feature:** Three CapnWeb RPC client factories mounted on /rpc.

**Location:** `apps/orchestrator/src/v2/catalyst-service.ts:146–159` (RPC mounting)

**Description:**
- Route: `/rpc` (all HTTP methods)
- Uses CapnWeb newRpcResponse for automatic routing.
- Three factory methods available:
  1. `getNetworkClient(token)` → validates token for PEER_CREATE action, returns NetworkClient.
  2. `getDataChannelClient(token)` → validates token for ROUTE_CREATE action, returns DataChannel.
  3. `getIBGPClient(token)` → validates token for IBGP_CONNECT action, extracts peer identity from JWT, returns IBGPClient.

**Dependencies:** `@hono/capnweb` newRpcResponse, CatalystService.getUpgradeWebSocket

**Public API Surface:**
```typescript
POST /rpc (CapnWeb protocol)
  getNetworkClient(token: string): Promise<NetworkClient | { error }>
  getDataChannelClient(token: string): Promise<DataChannel | { error }>
  getIBGPClient(token: string): Promise<IBGPClient | { error }>
```

### NetworkClient Interface

**Feature:** Peer management RPC API.

**Location:** `apps/orchestrator/src/v2/rpc.ts:32–39`

**Description:**
```typescript
interface NetworkClient {
  addPeer(peer: PeerInfo): Promise<{ success: true } | { success: false; error: string }>
  updatePeer(peer: PeerInfo): Promise<{ success: true } | { success: false; error: string }>
  removePeer(peer: Pick<PeerInfo, 'name'>): Promise<{ success: true } | { success: false; error: string }>
  listPeers(): Promise<PeerRecord[]>
}
```
- Each method validates caller token once at factory call time.
- addPeer → dispatch(LocalPeerCreate).
- updatePeer → dispatch(LocalPeerUpdate).
- removePeer → dispatch(LocalPeerDelete).
- listPeers → returns internal.peers with peerToken stripped.

**Dependencies:** Bus.dispatch, OrchestratorBus.state

**Public API Surface:**
- See NetworkClient interface above

### DataChannel Interface

**Feature:** Route management RPC API.

**Location:** `apps/orchestrator/src/v2/rpc.ts:41–49`

**Description:**
```typescript
interface DataChannel {
  addRoute(route: DataChannelDefinition): Promise<{ success: true } | { success: false; error: string }>
  removeRoute(route: Pick<DataChannelDefinition, 'name'>): Promise<{ success: true } | { success: false; error: string }>
  listRoutes(): Promise<{ local: DataChannelDefinition[]; internal: InternalRoute[] }>
}
```
- Each method validates caller token once at factory call time.
- addRoute → dispatch(LocalRouteCreate).
- removeRoute → dispatch(LocalRouteDelete).
- listRoutes → returns { local: internal.routes, internal: internal.routes } with peer.peerToken stripped.

**Dependencies:** Bus.dispatch, OrchestratorBus.state

**Public API Surface:**
- See DataChannel interface above

### IBGPClient Interface

**Feature:** iBGP protocol RPC API with peer identity binding.

**Location:** `apps/orchestrator/src/v2/rpc.ts:51–68`

**Description:**
```typescript
interface IBGPClient {
  open(data: { peerInfo: PeerInfo; holdTime?: number }): Promise<{ success: true } | { success: false; error: string }>
  close(data: { peerInfo: PeerInfo; code: number; reason?: string }): Promise<{ success: true } | { success: false; error: string }>
  update(data: { peerInfo: PeerInfo; update: UpdateMessage }): Promise<{ success: true } | { success: false; error: string }>
  keepalive(data: { peerInfo: PeerInfo }): Promise<{ success: true } | { success: false; error: string }>
}
```
- Token is validated and identity (JWT sub) is extracted at factory call.
- Each method verifies peerInfo.name === JWT sub (peer identity mismatch check).
- update() additionally verifies all nodePath[0] entries === JWT sub (route origin check).
- open → dispatch(InternalProtocolOpen).
- close → dispatch(InternalProtocolClose).
- update → dispatch(InternalProtocolUpdate).
- keepalive → dispatch(InternalProtocolKeepalive).

**Dependencies:** Bus.dispatch, decodeJwt from jose, token validator

**Public API Surface:**
- See IBGPClient interface above

---

## 9. Auth Integration

### Token Minting

**Feature:** Mint node JWT token from auth service on startup.

**Location:** `apps/orchestrator/src/v2/catalyst-service.ts:227–290` (mintNodeToken method)

**Description:**
- Called during onInitialize if orchestrator.auth is configured.
- Retries up to 5 times with exponential backoff (1s, 2s, 4s, 8s, 16s, capped at 30s).
- Calls auth service tokens().create() with:
  - subject: node.name
  - entity: { id: node.name, name: node.name, type: 'service', nodeId, trustedDomains }
  - principal: Principal.NODE
  - expiresIn: '7d'
- Stores token in _nodeToken, records _tokenIssuedAt and _tokenExpiresAt.
- Propagates token to v2 service on initialization.
- Logs on success or after max attempts exhausted.

**Dependencies:** Auth service RPC (WebSocket), jose for JWT handling

**Public API Surface:**
- Automatic during onInitialize

### Token Refresh

**Feature:** Periodic token refresh to keep node JWT fresh.

**Location:** `apps/orchestrator/src/v2/catalyst-service.ts:292–310` (refreshNodeTokenIfNeeded method)

**Description:**
- Refresh check interval: 1 hour.
- Refresh threshold: 80% of TTL (7 days = 5.6 days).
- If now >= refreshTime, calls mintNodeToken() again.
- Catches errors and logs (does not throw).
- SetInterval cleared on shutdown.

**Dependencies:** Auth service RPC (WebSocket)

**Public API Surface:**
- Automatic, checked every hour

### Token Validator

**Feature:** Validates RPC caller tokens before granting access to iBGP/peer/route operations.

**Location:** `apps/orchestrator/src/v2/catalyst-service.ts:175–225` (buildTokenValidator method)

**Description:**
- If auth not configured: reject all tokens (fail-closed).
- If auth configured: call authClient.permissions(token), then authorizeAction() with action name + nodeContext.
- Returns { valid: true } or { valid: false; error }.
- Called by RPC factory functions (createNetworkClient, createDataChannelClient, createIBGPClient) with action:
  - PEER_CREATE for network operations
  - ROUTE_CREATE for data channel operations
  - IBGP_CONNECT for protocol operations
- Errors logged as warnings (transient auth service failures don't crash bus).

**Dependencies:** Auth service RPC (WebSocket)

**Public API Surface:**
```typescript
interface TokenValidator {
  validateToken(
    token: string,
    action: string
  ): Promise<{ valid: true } | { valid: false; error: string }>
}
```

### Configuration

**Feature:** Auth service endpoint and system token configured via OrchestratorConfig.

**Location:**
- `apps/orchestrator/src/v2/catalyst-service.ts:102–116`
- `apps/orchestrator/src/v2/catalyst-service.ts:236–237`

**Description:**
- Optional config: `orchestrator.auth.endpoint` (WebSocket URL), `orchestrator.auth.systemToken` (bearer token).
- If omitted, no token minting, no auth validation (all RPC calls fail).
- If present, token minting attempted and all RPC calls require authorization.

**Dependencies:** OrchestratorConfig schema

**Public API Surface:**
```typescript
// Via OrchestratorConfig
auth?: {
  endpoint: string        // WebSocket endpoint for auth service
  systemToken: string     // Bearer token for system-level operations
}
```

---

## 10. Service Lifecycle

### Start

**Feature:** Initialize bus and start timers.

**Location:** `apps/orchestrator/src/v2/service.ts:124–127` (OrchestratorServiceV2.start)

**Description:**
- Recalculates tick interval from current peer holdTimes.
- Calls tickManager.start() to begin periodic Tick dispatch.
- Called from OrchestratorService.onInitialize() after v2 service construction.

**Dependencies:** TickManager

**Public API Surface:**
```typescript
start(): void
```

### Stop

**Feature:** Cancel all timers and pending reconnects.

**Location:** `apps/orchestrator/src/v2/service.ts:140–143` (OrchestratorServiceV2.stop)

**Description:**
- Calls tickManager.stop() to cancel interval.
- Calls reconnectManager.stopAll() to cancel pending reconnects.
- Called from OrchestratorService.onShutdown() on graceful shutdown.

**Dependencies:** TickManager, ReconnectManager

**Public API Surface:**
```typescript
async stop(): Promise<void>
```

### Tick Manager Ownership

**Feature:** OrchestratorServiceV2 owns and recalculates tick manager.

**Location:**
- `apps/orchestrator/src/v2/service.ts:99–101` (construction)
- `apps/orchestrator/src/v2/service.ts:134–137` (recalculate on peer events)

**Description:**
- Constructor: creates TickManager with dispatchFn bound to bus.dispatch.
- Wraps bus.dispatch to detect peer open/connected actions and recalculate interval.
- Recalculation: tick interval = max(1000ms, floor(min(active holdTimes) / 3)).

**Dependencies:** TickManager, Bus.dispatch

**Public API Surface:**
```typescript
readonly tickManager: TickManager
recalculateTickInterval(): void  // Called on peer events
```

### Reconnect Manager Ownership

**Feature:** OrchestratorServiceV2 owns reconnect manager for transport errors.

**Location:** `apps/orchestrator/src/v2/service.ts:115–120` (construction)

**Description:**
- Constructor: creates ReconnectManager with transport, dispatchFn, nodeToken.
- Coordinates with transport to detect peer close events and schedule retries.
- Called from external code (e.g. reconnect.ts) when transport.openPeer() fails.

**Dependencies:** ReconnectManager, PeerTransport

**Public API Surface:**
```typescript
readonly reconnectManager: ReconnectManager
```

### Journal Replay

**Feature:** On startup, replay all journaled actions to reconstruct route table.

**Location:** `apps/orchestrator/src/v2/service.ts:52–69` (service constructor)

**Description:**
- Create temporary RIB with no journal.
- For each journaled entry: call plan() + commit() to rebuild state.
- Use replayed state as initialState for main bus RIB.
- New actions append to journal from that point forward.

**Dependencies:** ActionLog, RoutingInformationBase

**Public API Surface:**
- Automatic in OrchestratorServiceV2 constructor

---

## 11. Configuration

### OrchestratorConfig

**Feature:** Top-level config object for all orchestrator settings.

**Location:** `apps/orchestrator/src/v1/types.ts` (type defined, reused by v2)

**Description:**
- `node.name` (required): local node identifier
- `node.domains` (required): list of domains for this node
- `node.endpoint` (required for v2): WebSocket URL for inbound RPC
- `orchestrator.auth?` (optional): { endpoint, systemToken }
- `orchestrator.gqlGatewayConfig?` (optional): { endpoint }
- `orchestrator.envoyConfig?` (optional): { endpoint, portRange }

**Dependencies:** OrchestratorConfig type from v1

**Public API Surface:**
```typescript
// Via OrchestratorConfig
node: {
  name: string
  domains: string[]
  endpoint?: string
}
orchestrator?: {
  auth?: { endpoint: string; systemToken: string }
  gqlGatewayConfig?: { endpoint: string }
  envoyConfig?: { endpoint: string; portRange: PortRange }
}
```

### Optional Dependencies

**Feature:** Gateway, envoy, and port allocator are all optional.

**Location:**
- `apps/orchestrator/src/v2/service.ts:73–85` (optional client/allocator creation)
- `apps/orchestrator/src/v2/bus.ts:206–207` (no-op if undefined)

**Description:**
- If gqlGatewayConfig omitted: no gateway sync performed.
- If envoyConfig omitted: no envoy sync or port allocation performed.
- Bus gracefully handles None clients (fire-and-forget with no-op).
- Allows orchestrator to run in minimal mode for testing or local development.

**Dependencies:** None (optional pattern)

**Public API Surface:**
- See OrchestratorConfig above

---

## 12. Transport Layer

### PeerTransport Interface

**Feature:** Abstraction over peer-to-peer communication (WebSocket or mock).

**Location:** `apps/orchestrator/src/v2/transport.ts:11–16`

**Description:**
```typescript
interface PeerTransport {
  sendUpdate(peer: PeerRecord, message: UpdateMessage): Promise<void>
  sendKeepalive(peer: PeerRecord): Promise<void>
  openPeer(peer: PeerRecord, token: string): Promise<void>
  closePeer(peer: PeerRecord, code: number, reason?: string): Promise<void>
}
```
- All methods are async and fire-and-forget in the bus (errors swallowed).
- Implementations can choose sync or async behavior.

**Dependencies:** None (interface only)

**Public API Surface:**
- See PeerTransport interface above

### WebSocketPeerTransport

**Feature:** Production transport using capnweb RPC over WebSocket.

**Location:** `apps/orchestrator/src/v2/ws-transport.ts`

**Description:**
- Maintains a pool of WebSocket RPC stubs (one per endpoint URL).
- For each call:
  1. Get or create stub for peer.endpoint.
  2. Call getIBGPClient(peerToken) on remote PublicApi.
  3. Call the desired method (open, sendUpdate, sendKeepalive, close) on the returned client.
- Stubs are lazy-initialized and reused (caching at endpoint granularity).
- closePeer deletes the stub after closing to force reconnection on next peer dial.
- Errors propagated to caller (fire-and-forget handled by bus).

**Dependencies:** `capnweb` newWebSocketRpcSession, RemotePublicApi interface

**Public API Surface:**
```typescript
class WebSocketPeerTransport implements PeerTransport {
  constructor(opts: { localNodeInfo: { name: string; domains: string[] } })
}
```

### MockPeerTransport

**Feature:** Test-friendly transport that records all calls.

**Location:** `apps/orchestrator/src/v2/transport.ts:29–68`

**Description:**
- Records all calls in order: `calls: TransportCall[]`.
- Can be set to fail mode: `setShouldFail(true)` to throw on all subsequent calls.
- Methods:
  - `getCallsFor(method)`: filter recorded calls by method name.
  - `reset()`: clear calls and reset failure flag.
- Useful for asserting that the bus made expected transport calls without actual network.

**Dependencies:** None

**Public API Surface:**
```typescript
class MockPeerTransport implements PeerTransport {
  readonly calls: TransportCall[]
  setShouldFail(fail: boolean): void
  getCallsFor(method: TransportCall['method']): TransportCall[]
  reset(): void
}
```

---

## 13. Logging/Telemetry

### Logging

**Feature:** Structured logging via telemetry service.

**Location:**
- `apps/orchestrator/src/v2/catalyst-service.ts` (CatalystService methods log via this.telemetry.logger)
- `apps/orchestrator/src/v2/rpc.ts:14` (logger for iBGP identity checks)
- `apps/orchestrator/src/v2/ws-transport.ts:37` (logger for transport)
- `apps/orchestrator/src/v2/reconnect.ts:7` (logger for reconnects)

**Description:**
- Uses @catalyst/telemetry tagged template literals.
- Token minting: logs on mint success, refresh attempt, and token exhaustion.
- Auth validation: logs warnings on mismatches.
- Transport: logs on open success.
- Reconnect: logs attempt count and backoff delay.
- Graceful: logs warnings on skipped reconnects (no token).

**Dependencies:** @catalyst/telemetry getLogger

**Public API Surface:**
- Logging is fire-and-forget, no explicit API exposed

### Telemetry Ownership

**Feature:** CatalystService owns and exposes telemetry.

**Location:** `apps/orchestrator/src/v2/catalyst-service.ts:4–5` (extends CatalystService)

**Description:**
- All v2 code accesses telemetry via this.telemetry (inherited from CatalystService).
- Loggers include context: ['catalyst', 'orchestrator', ...].

**Dependencies:** CatalystService

**Public API Surface:**
- Via inherited CatalystService.telemetry

---

## 14. Error Handling

### Fire-and-Forget Patterns

**Feature:** Post-commit side effects don't block action dispatch on error.

**Location:**
- `apps/orchestrator/src/v2/bus.ts:138–159` (handlePostCommit wraps all handlers)
- `apps/orchestrator/src/v2/bus.ts:188–190` (BGP notify catches errors)
- `apps/orchestrator/src/v2/bus.ts:219–221` (gateway sync catches errors)
- `apps/orchestrator/src/v2/bus.ts:284–286` (envoy sync catches errors)
- `apps/orchestrator/src/v2/bus.ts:359–361` (keepalive catch errors)

**Description:**
- All transport calls, gateway calls, and envoy calls are wrapped in try-catch.
- Errors are swallowed (no rethrow).
- One peer/service failure doesn't disrupt others (allSettled used where appropriate).
- Callers see dispatch() success even if a side effect failed.
- Allows system to remain operational if external services are temporarily unavailable.

**Dependencies:** None (catch patterns)

**Public API Surface:**
- Fire-and-forget is internal behavior, not externally visible

### Token Validation Error Handling

**Feature:** Auth failures are logged but don't crash RPC calls.

**Location:** `apps/orchestrator/src/v2/catalyst-service.ts:194–222` (validateToken try-catch)

**Description:**
- Transient auth service errors are caught, logged, and return { valid: false, error }.
- RPC factory functions check validity and return { success: false, error } to caller.
- Caller receives clear error message but bus continues running.

**Dependencies:** None (try-catch pattern)

**Public API Surface:**
```typescript
// RPC factory returns
{ success: false; error: string }  // On validation failure
```

### Reconnect Backoff

**Feature:** Transport errors trigger exponential backoff retries.

**Location:** `apps/orchestrator/src/v2/reconnect.ts:49–69` (scheduleReconnect)

**Description:**
- First reconnect: 1s
- Subsequent: 2s, 4s, 8s, ... capped at maxBackoffMs (default 60s)
- Retries are scheduled independently per peer.
- On success: attempt counter resets to 0.
- On continued failure: attempt counter increments, scheduling next retry with increased delay.

**Dependencies:** None (setTimeout)

**Public API Surface:**
```typescript
class ReconnectManager {
  scheduleReconnect(peer: PeerRecord): void
  cancelReconnect(peerName: string): void
  stopAll(): void
}
```

---

## 15. Graceful Restart

### Stale Route Marking

**Feature:** Routes are marked stale on transport error, not immediately withdrawn.

**Location:** `packages/routing/src/v2/rib/rib.ts:323–341` (planInternalProtocolClose)

**Description:**
- Transport error (code=3): mark peer's routes isStale=true, emit 'updated'.
- Other close reasons: withdraw routes immediately, emit 'removed'.
- Allows quick reconnection to reuse routes without re-learning them.
- Stale routes still propagate downstream (gateway, envoy), but are skipped in initial sync to new peers.

**Dependencies:** CloseCodes enum

**Public API Surface:**
- Automatic in planInternalProtocolClose

### Stale Route Purge

**Feature:** Routes from a peer remain stale until holdTime grace period elapses.

**Location:** `packages/routing/src/v2/rib/rib.ts:470–486` (planTick handler, stale purge logic)

**Description:**
- On Tick: check closed peers with stale routes.
- If holdTime elapses without reconnection: purge stale routes.
- Prevents indefinite stale route accumulation.
- If peer reconnects before grace expires: fresh routes replace stale ones (better-path selection).

**Dependencies:** None (time-based logic)

**Public API Surface:**
- Automatic on Tick dispatch

### Port Preservation During Restart

**Feature:** Ports are not released on transport error (only on normal close).

**Location:** `packages/routing/src/v2/rib/rib.ts:330–341` (planInternalProtocolClose: portOps = NO_PORT_OPS on TRANSPORT_ERROR)

**Description:**
- On TRANSPORT_ERROR: no portOps, routes stale, ports stay allocated.
- On other close: ports released, allowing reassignment.
- Allows quick reconnect to reuse same ports (less disruption to data plane).

**Dependencies:** None (conditional logic)

**Public API Surface:**
- Automatic in planInternalProtocolClose

---

## 16. Peer Identity Binding

**Feature:** iBGP requests are bound to authenticated peer identity.

**Location:** `apps/orchestrator/src/v2/rpc.ts:158–257` (createIBGPClient)

**Description:**
- Token is validated and JWT sub claim extracted (peer identity).
- All iBGP methods verify peerInfo.name === JWT sub.
- update() additionally verifies nodePath[0] === JWT sub for all route updates.
- Prevents compromised peer from spoofing another node's identity.
- Returns clear error message on mismatch, no dispatch to bus.

**Dependencies:** `jose` decodeJwt, TokenValidator

**Public API Surface:**
```typescript
// Internal identity verification
function verifyPeerName(peerInfo: PeerInfo): { success: true } | { success: false; error: string }
```

---

## 17. Node Token Management

**Feature:** Orchestrator mints and manages a node JWT for outbound iBGP auth.

**Location:**
- `apps/orchestrator/src/v2/catalyst-service.ts:227–290` (token minting)
- `apps/orchestrator/src/v2/catalyst-service.ts:292–310` (token refresh)
- `apps/orchestrator/src/v2/service.ts:145–149` (propagate to bus/reconnect)

**Description:**
- On startup: mint node token from auth service (system-level operation).
- Store token, issue time, expiry time.
- Refresh check every hour: if 80% of TTL elapsed, remint.
- Propagate token to bus and reconnect manager so they can authenticate outbound iBGP calls.
- Token refresh catches errors and logs (doesn't fail).

**Dependencies:** Auth service RPC (WebSocket)

**Public API Surface:**
```typescript
setNodeToken(token: string): void  // Propagate refreshed token
```

---

## 18. RIB State Management

### RIB as State Machine

**Feature:** RoutingInformationBase is the canonical state machine.

**Location:** `packages/routing/src/v2/rib/rib.ts:70–138`

**Description:**
- Single mutable field: _state (RouteTable).
- All actions flow through plan/commit pipeline.
- plan() is pure, commit() updates _state and journals.
- stateChanged() detects real transitions via reference equality.
- Suitable for replaying from journal, testing with mocks, or reconstructing on restart.

**Dependencies:** None (pure state machine)

**Public API Surface:**
```typescript
class RoutingInformationBase {
  get state(): RouteTable
  get nodeId(): string
  plan(action: Action, state: RouteTable): PlanResult
  commit(plan: PlanResult, action: Action): RouteTable
  stateChanged(plan: PlanResult): boolean
}
```

### Action Handlers

**Feature:** Complete switch statement over all 11 action types.

**Location:** `packages/routing/src/v2/rib/rib.ts:96–123` (plan switch)

**Description:**
- LocalPeerCreate, LocalPeerUpdate, LocalPeerDelete
- LocalRouteCreate, LocalRouteDelete
- InternalProtocolOpen, InternalProtocolConnected, InternalProtocolClose, InternalProtocolUpdate, InternalProtocolKeepalive
- Tick
- Each handler returns PlanResult with state transition logic.

**Dependencies:** All action type constants from @catalyst/routing/v2

**Public API Surface:**
- Via plan() method (handlers are private)

---

## Summary: Public Export Surface

**Location:** `apps/orchestrator/src/v2/index.ts`

```typescript
// Types/Interfaces
export type {
  StateResult,
  GatewayClient,
  GatewayUpdateResult,
  EnvoyClient,
  EnvoyUpdateResult,
  BusPortAllocator,
}

export type {
  PeerTransport,
  UpdateMessage,
  TransportCall,
}

export type {
  NetworkClient,
  DataChannel,
  IBGPClient,
  TokenValidator,
}

// Classes
export class OrchestratorBus { ... }
export class TickManager { ... }
export class ReconnectManager { ... }
export class OrchestratorServiceV2 { ... }
export class MockPeerTransport { ... }

// Factories
export function createNetworkClient(...): Promise<...>
export function createDataChannelClient(...): Promise<...>
export function createIBGPClient(...): Promise<...>
export function createGatewayClient(endpoint: string): GatewayClient
export function createEnvoyClient(endpoint: string): EnvoyClient
```

---

## Action Type Constants

**Location:** `packages/routing/src/v2/action-types.ts`

```typescript
export const Actions = {
  LocalPeerCreate: 'local:peer:create',
  LocalPeerUpdate: 'local:peer:update',
  LocalPeerDelete: 'local:peer:delete',
  LocalRouteCreate: 'local:route:create',
  LocalRouteDelete: 'local:route:delete',
  InternalProtocolOpen: 'internal:protocol:open',
  InternalProtocolClose: 'internal:protocol:close',
  InternalProtocolConnected: 'internal:protocol:connected',
  InternalProtocolUpdate: 'internal:protocol:update',
  InternalProtocolKeepalive: 'internal:protocol:keepalive',
  Tick: 'system:tick',
}
```

---

## Close Codes

**Location:** `packages/routing/src/v2/close-codes.ts`

```typescript
export const CloseCodes = {
  NORMAL: 1,                  // Operator-initiated peer removal
  HOLD_EXPIRED: 2,            // No message within holdTime
  TRANSPORT_ERROR: 3,         // WebSocket/RPC failure
  ADMIN_SHUTDOWN: 4,          // Node shutting down
  PROTOCOL_ERROR: 5,          // Schema validation / malformed message
}
```

---

## Testing Utilities

### MockPeerTransport

**Feature:** Record and assert transport calls without real networking.

**Location:** `apps/orchestrator/src/v2/transport.ts:29–68`

**Public API Surface:**
```typescript
class MockPeerTransport implements PeerTransport {
  readonly calls: TransportCall[]
  setShouldFail(fail: boolean): void
  getCallsFor(method: 'sendUpdate' | 'sendKeepalive' | 'openPeer' | 'closePeer'): TransportCall[]
  reset(): void
}
```

---

## Integration Points

### CatalystService Wrapper

**Feature:** v2 orchestrator is wrapped in CatalystService for HTTP server integration.

**Location:** `apps/orchestrator/src/v2/catalyst-service.ts`

**Description:**
- Extends CatalystService (provides Hono route group, telemetry, lifecycle hooks).
- onInitialize: mints token, creates transport, constructs v2 service, mounts RPC route.
- onShutdown: stops v2 service (timers + reconnects).
- Exposes v2 instance via getter for direct access (rarely needed).

**Dependencies:** @catalyst/service CatalystService

**Public API Surface:**
```typescript
class OrchestratorService extends CatalystService {
  get v2(): OrchestratorServiceV2
}
```

---

## Known Limitations

1. **Port allocations ephemeral** — reset on restart (no persistent port state).
2. **Stale route metadata not persisted** — restarted node loses isStale marking (routes will be re-learned or expired).
3. **lastKeepaliveSent ephemeral** — restarted node loses track of last keepalive time (immediate keepalive possible on restart).
4. **No external peering policy** — ConfigurableRoutePolicy is pass-through (M3 feature).
5. **No route metadata storage** — no alternative path tracking or selection reason logging (future enhancement).
6. **No circuit breaker** — repeated auth service failures don't trigger fallback (external services required).

---

## Notable Behaviors

1. **BGP loop detection** — Enforced at two points: incoming update (skip if nodePath contains nodeId) and delta fan-out (skip if nodePath contains peer).
2. **Split-horizon** — Don't send peer its own routes back (implicit in peer discrimination).
3. **Best-path selection** — Prefer shorter nodePath, or replace stale routes (deterministic within same path length).
4. **Tick interval dynamic** — Recalculated after peer open/connected to track min(holdTime) / 3.
5. **Fire-and-forget pattern** — All side effects (gateway, envoy, transport) are non-blocking; failures don't disrupt dispatch.
6. **Graceful restart** — Transport errors mark routes stale instead of withdrawing, allowing quick reconnection.
7. **Port allocation naming** — Local routes use route.name, internal routes use "egress_{name}_via_{peer.name}".
8. **Token refresh lazy** — Refresh only checked hourly, not on every dispatch (background process).
9. **Identity binding** — iBGP requests bound to JWT sub, preventing peer spoofing.
10. **Stale route purge by holdTime** — Closed peers with stale routes are purged after holdTime grace (prevents indefinite stale accumulation).

