# V1 Orchestrator Capabilities Catalog

**Last Updated:** 2026-03-10
**Scope:** `apps/orchestrator/src/v1/` — All features, behaviors, and public API surface of the v1 CatalystNodeBus orchestrator.

---

## 1. Core Architecture

### 1.1 Main Class: CatalystNodeBus

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:130–1038`

The central orchestrator class that:

- Manages state (RouteTable) for local routes, internal peers, and internal routes
- Implements the dispatch pipeline for actions
- Handles side effects (BGP notifications, Envoy sync, GraphQL gateway sync)
- Exposes a public RPC API via `publicApi()` method
- Validates caller tokens via auth service

**Key fields:**

- `state: RouteTable` — Current route table state (local routes, internal peers/routes)
- `connectionPool: ConnectionPool` — Pools RPC stubs for peer orchestrators and external services
- `config: OrchestratorConfig` — Node configuration, auth endpoints, Envoy config
- `nodeToken?: string` — Minted token for this orchestrator node
- `authClient?: RpcStub<AuthServiceApi>` — RPC client to auth service
- `portAllocator?: PortAllocator` — Port allocator for Envoy integration
- `lastNotificationPromise?: Promise<void>` — Tracks pending side effects

### 1.2 Service Wrapper: OrchestratorService

**Location:** `apps/orchestrator/src/v1/service.ts:42–177`

Extends `CatalystService` abstract base class.

**Lifecycle:**

- Inherits from `CatalystService` (config injection, telemetry, lifecycle hooks)
- `onInitialize()` → Mints node token, sets up token refresh interval, builds CatalystNodeBus, mounts RPC route
- `onShutdown()` → Clears token refresh interval

**Service metadata:**

- Name: `'orchestrator'`
- Version: `'0.0.0'`

**Token refresh mechanism:**

- Refresh threshold: 80% of token lifetime
- Refresh check interval: every 1 hour
- Token TTL: 7 days (604,800,000 ms)
- If auth service configured: automatic token minting and periodic refresh
- Non-fatal: Errors during refresh are logged but don't stop the service

---

## 2. State Management

### 2.1 RouteTable Structure

**Type Definition:** `packages/routing/src/v1/state.ts:25–50`

```typescript
type RouteTable = {
  local: {
    routes: DataChannelDefinition[]
  }
  internal: {
    peers: PeerRecord[]
    routes: InternalRoute[]
  }
  external: {
    [key: string]: unknown
  }
}
```

**Components:**

#### 2.1.1 Local Routes

- **Type:** `DataChannelDefinition[]`
- **Contains:** Routes registered on this node
- **Fields per route:**
  - `name` (string, 1–253 chars, regex: `/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i`)
  - `endpoint` (optional URL)
  - `protocol` (enum: `http`, `http:graphql`, `http:gql`, `http:grpc`, `tcp`)
  - `region` (optional string)
  - `tags` (optional string[])
  - `envoyPort` (optional integer, allocated by port allocator)

#### 2.1.2 Internal Peers

- **Type:** `PeerRecord[]`
- **Contains:** iBGP peer configurations and connection state
- **Fields per peer:**
  - `name` (string)
  - `domains` (string[])
  - `endpoint` (optional string — RPC endpoint)
  - `labels` (optional record of key–value strings)
  - `peerToken` (optional string — token minted by remote auth service for use by this node)
  - `envoyAddress` (optional string — reachable address of peer's Envoy proxy)
  - `connectionStatus` (enum: `'initializing'`, `'connected'`, `'closed'`)
  - `lastConnected` (optional date)

#### 2.1.3 Internal Routes

- **Type:** `InternalRoute[]` (DataChannelDefinition + peer + nodePath)
- **Contains:** Routes learned from peer orchestrators
- **Additional fields:**
  - `peer: PeerInfo` — originating peer
  - `nodePath: string[]` — sequence of node names from origin to this node (for loop detection)

### 2.2 Dispatch Pipeline

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:234–263`

**Flow:**

1. `dispatch(action)` → Receives action
2. `handleAction(action, state)` → Applies state transformation
3. If successful → `state = newState`, then fire-and-forget `handleNotify(action, newState, oldState)`
4. If error → Log and return failure

**Key detail:** Notifications are asynchronous (fire-and-forget) to avoid deadlocks in distributed calls. Last promise tracked in `lastNotificationPromise`.

---

## 3. Action Types & Handlers

**Location:** `packages/routing/src/v1/action-types.ts:5–23`

### 3.1 Complete Action List

| Action                        | Constant                    | Category | Triggered By                                                       |
| ----------------------------- | --------------------------- | -------- | ------------------------------------------------------------------ |
| `local:peer:create`           | `LocalPeerCreate`           | Local    | NetworkClient.addPeer()                                            |
| `local:peer:update`           | `LocalPeerUpdate`           | Local    | NetworkClient.updatePeer()                                         |
| `local:peer:delete`           | `LocalPeerDelete`           | Local    | NetworkClient.removePeer()                                         |
| `local:route:create`          | `LocalRouteCreate`          | Local    | DataChannel.addRoute()                                             |
| `local:route:delete`          | `LocalRouteDelete`          | Local    | DataChannel.removeRoute()                                          |
| `internal:protocol:open`      | `InternalProtocolOpen`      | iBGP     | IBGPClient.open()                                                  |
| `internal:protocol:close`     | `InternalProtocolClose`     | iBGP     | IBGPClient.close()                                                 |
| `internal:protocol:connected` | `InternalProtocolConnected` | iBGP     | Internal: dispatch after successful connection                     |
| `internal:protocol:update`    | `InternalProtocolUpdate`    | iBGP     | IBGPClient.update()                                                |
| `system:tick`                 | `Tick`                      | System   | (Not implemented in v1, defined in routing package for future use) |

### 3.2 Action Handlers in handleAction()

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:266–482`

#### 3.2.1 LocalPeerCreate

**Data:** `PeerInfo` (requires `peerToken`)

- **State change:** Append peer with `connectionStatus: 'initializing'`
- **Validation:**
  - Check if peer already exists (duplicate check)
  - Require `peerToken` (fail if missing)
- **Error cases:** Duplicate peer, missing token

#### 3.2.2 LocalPeerUpdate

**Data:** `PeerInfo`

- **State change:** Find peer by name, update fields (endpoint, domains, peerToken, reset connectionStatus to 'initializing')
- **Validation:** Check peer exists
- **Error cases:** Peer not found

#### 3.2.3 LocalPeerDelete

**Data:** `{ name: string }`

- **State change:** Remove peer by name
- **Validation:** Check peer exists
- **Error cases:** Peer not found

#### 3.2.4 LocalRouteCreate

**Data:** `DataChannelDefinition`

- **State change:** Append route to local.routes
- **Validation:** Check route name is unique
- **Error cases:** Route already exists

#### 3.2.5 LocalRouteDelete

**Data:** `DataChannelDefinition`

- **State change:** Remove route by name from local.routes
- **Validation:** Check route exists
- **Error cases:** Route not found

#### 3.2.6 InternalProtocolOpen

**Data:** `{ peerInfo: PeerInfo }`

- **State change:** Mark peer as 'connected' (if not already)
- **Validation:** Check peer exists in local peer list
- **Semantics:** Inbound connection request from a peer — this node should sync existing routes back
- **Error cases:** Peer not in local config

#### 3.2.7 InternalProtocolConnected

**Data:** `{ peerInfo: PeerInfo }`

- **State change:** Mark peer as 'connected'
- **Semantics:** Connection established (result of LocalPeerCreate side effect)
- **Idempotent:** No-op if already connected

#### 3.2.8 InternalProtocolClose

**Data:** `{ peerInfo: PeerInfo, code: number, reason?: string }`

- **State change:** Remove peer from internal.peers and filter out internal.routes originating from that peer
- **Semantics:** Peer connection closed — withdraw all routes learned from this peer
- **Side effects:** Trigger withdrawal propagation to other connected peers

#### 3.2.9 InternalProtocolUpdate

**Data:** `{ peerInfo: PeerInfo, update: UpdateMessageSchema }`

- **Update message format:**
  ```typescript
  { updates: [
      { action: 'add' | 'remove', route: DataChannelDefinition, nodePath?: string[] }
    ]
  }
  ```
- **State change:** For each update:
  - **'add':** Upsert route (remove old entry by name + peer, append new)
  - **'remove':** Filter out route by name + peer
- **Validation:**
  - Loop prevention: Drop update if `this.config.node.name` is in `nodePath`
  - Default `nodePath` to `[]` if missing
- **Error cases:** None — invalid/looped updates are silently dropped

---

## 4. Public API Surface

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:25–35, 941–1037`

**Mounted at:** `/rpc` endpoint via `newRpcResponse(c, this._bus.publicApi())`

### 4.1 PublicApi Interface

Three client getter methods, each requiring a token:

#### 4.1.1 getNetworkClient(token: string)

**Returns:** `{ success: true; client: NetworkClient } | { success: false; error: string }`

**Methods on NetworkClient:**

- `addPeer(peer: PeerInfo) → Promise<{ success: true } | { success: false; error: string }>`
  - Dispatches `LocalPeerCreate` action
  - Token validated with action `'PEER_CREATE'`
- `updatePeer(peer: PeerInfo) → Promise<{ success: true } | { success: false; error: string }>`
  - Dispatches `LocalPeerUpdate` action
  - Token validated with action `'PEER_CREATE'` (same permission)
- `removePeer(peer: Pick<PeerInfo, 'name'>) → Promise<{ success: true } | { success: false; error: string }>`
  - Dispatches `LocalPeerDelete` action
  - Token validated with action `'PEER_CREATE'` (same permission)
- `listPeers() → Promise<PeerRecord[]>`
  - Returns current `state.internal.peers` with `peerToken` fields filtered out (security)
  - No token validation (read-only)

#### 4.1.2 getDataChannelClient(token: string)

**Returns:** `{ success: true; client: DataChannel } | { success: false; error: string }`

**Methods on DataChannel:**

- `addRoute(route: DataChannelDefinition) → Promise<{ success: true } | { success: false; error: string }>`
  - Dispatches `LocalRouteCreate` action
  - Token validated with action `'ROUTE_CREATE'`
- `removeRoute(route: DataChannelDefinition) → Promise<{ success: true } | { success: false; error: string }>`
  - Dispatches `LocalRouteDelete` action
  - Token validated with action `'ROUTE_CREATE'` (same permission)
- `listRoutes() → Promise<{ local: DataChannelDefinition[]; internal: InternalRoute[] }>`
  - Returns `state.local.routes` and `state.internal.routes` (with peerToken filtered)
  - No token validation (read-only)

#### 4.1.3 getIBGPClient(token: string)

**Returns:** `{ success: true; client: IBGPClient } | { success: false; error: string }`

**Methods on IBGPClient:**

- `open(peer: PeerInfo) → Promise<{ success: true } | { success: false; error: string }>`
  - Dispatches `InternalProtocolOpen` action
  - Token validated with action `'IBGP_CONNECT'`
- `close(peer: PeerInfo, code: number, reason?: string) → Promise<{ success: true } | { success: false; error: string }>`
  - Dispatches `InternalProtocolClose` action
  - Token validated with action `'IBGP_CONNECT'` (same permission)
- `update(peer: PeerInfo, update: UpdateMessageSchema) → Promise<{ success: true } | { success: false; error: string }>`
  - Dispatches `InternalProtocolUpdate` action
  - Token validated with action `'IBGP_CONNECT'` (same permission)

---

## 5. BGP Protocol Implementation

### 5.1 Initial Sync (InternalProtocolOpen / InternalProtocolConnected)

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:556–661`

When a peer connects (either inbound via `open()` or outbound via side effect):

1. **Collect routes:** Combine local routes + internal routes
2. **Filter split-horizon:** Remove routes with peer in nodePath (don't send back to sender)
3. **Port rewriting for multi-hop:** If route is transited (internal.routes), allocate egress port locally
   - Key: `egress_${route.name}_via_${route.peer.name}`
   - Preserve remote port in `route.envoyPort` for upstream cluster target
4. **Send:** Call peer's `IBGPClient.update(this.config.node, { updates: [...] })`

**Important detail:** Uses peer's local `peerToken` (from state), not `peerInfo.peerToken` from remote (which is remote auth's token for them).

### 5.2 Delta Fan-Out (LocalRouteCreate / LocalRouteDelete)

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:688–741`

When local routes are added or removed:

1. **Collect connected peers:** Filter `state.internal.peers` by `connectionStatus === 'connected'`
2. **For each peer:**
   - Serialize update: `{ action: 'add' | 'remove', route, nodePath: [this.config.node.name] }`
   - Call peer's `IBGPClient.update()`
3. **Error handling:** Log error, continue (fire-and-forget)

### 5.3 Route Propagation (InternalProtocolUpdate)

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:743–802`

When receiving an update from a peer:

1. **Filter safe updates:** Exclude updates with:
   - Loops: `nodePath.includes(this.config.node.name)`
   - Split-horizon: `nodePath.includes(target_peer.name)`
   - Removals: always safe (no path check)
2. **For each connected peer (except source):**
   - Prepend node name: `nodePath = [this.config.node.name, ...nodePath]`
   - Rewrite ports: Allocate egress port for multi-hop
   - Call peer's `IBGPClient.update()`

**Port rewriting for multi-hop:**

- For add-type updates: allocate local egress port
- Key: `egress_${route.name}_via_${sourcePeerName}`
- Remote port preserved; local port used as listener

### 5.4 Withdrawal Propagation (LocalPeerDelete / InternalProtocolClose)

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:907–938`

When a peer is removed or closes:

1. **Find all internal routes from that peer** in prevState
2. **For each connected peer (except deleted peer):**
   - Send removal update: `{ action: 'remove', route }`
3. **Error handling:** Log, continue

### 5.5 Loop Detection

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:445–449`

In `handleAction()` for `InternalProtocolUpdate`:

- Check `nodePath.includes(this.config.node.name)`
- If true: log debug message, skip update (silently drop)

---

## 6. Envoy Integration

### 6.1 Port Allocation

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:811–895`

**Trigger:** Any route-affecting action (Create/Delete/Update/Close/Open/Connected)

**Local routes:**

- On first allocation: call `portAllocator.allocate(route.name)`
- On deletion: call `portAllocator.release(route.name)`
- Update `route.envoyPort` in state

**Internal routes (multi-hop egress):**

- On allocation: `portAllocator.allocate(egress_${name}_via_${peerName})`
- On peer close: `portAllocator.release(egress_${name}_via_${peerName})`
- If no envoyPort from upstream: set to allocated port; else preserve upstream port

**PortAllocator interface:**

- `allocate(name): { success, port } | { success: false, error }`
- `release(name): void`
- `getPort(name): number | undefined`
- `getAllocations(): ReadonlyMap<string, number>`

### 6.2 Envoy Configuration Sync

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:879–895`

**Triggered:** After handleNotify (async, fire-and-forget)

**Payload sent to Envoy service:**

```typescript
{
  local: this.state.local.routes,
  internal: this.state.internal.routes,
  portAllocations: Object.fromEntries(this.portAllocator.getAllocations())
}
```

**RPC call:** `stub.updateRoutes(payload)` (via connection pool)

**Error handling:** Log error, don't retry

---

## 7. GraphQL Gateway Sync

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:485–521`

### 7.1 Trigger and Filter

- Triggered: After any action (via `handleNotify`)
- Filter routes: By protocol `'http:graphql'` OR `'http:gql'`
- Include: Both local and internal routes

### 7.2 Payload

```typescript
{
  services: [{ name: route.name, url: route.endpoint! }]
}
```

### 7.3 RPC Call

- Endpoint: `config.gqlGatewayConfig.endpoint`
- Method: `updateConfig(config)`
- Error handling: Log error, don't retry

---

## 8. Authentication & Token Validation

### 8.1 Auth Service Integration

**Location:** `apps/orchestrator/src/v1/service.ts:111–176`

**Auth service RPC interfaces:**

```typescript
interface AuthServiceApi {
  tokens(token: string): Promise<TokensApi | { error: string }>
}

interface TokensApi {
  create(request: TokenRequest): Promise<string>
  revoke(request: { jti?: string; san?: string }): Promise<void>
  list(request: { ... }): Promise<unknown[]>
}
```

### 8.2 Node Token Minting

**Location:** `apps/orchestrator/src/v1/service.ts:111–153`

On service initialization:

1. If no auth configured: skip (return)
2. Connect to auth service via WebSocket RPC
3. Call `tokensApi.create()`
4. **Token request:**
   ```typescript
   {
     subject: this.config.node.name,
     entity: {
       id: this.config.node.name,
       name: this.config.node.name,
       type: 'service',
       nodeId: this.config.node.name,
       trustedNodes: [],
       trustedDomains: this.config.node.domains
     },
     principal: Principal.NODE,
     expiresIn: '7d'
   }
   ```
5. Track issue/expiry times for refresh logic
6. Error handling: Log and throw (service startup fails)

### 8.3 Token Refresh

**Location:** `apps/orchestrator/src/v1/service.ts:155–176`

**Interval:** Every 1 hour (REFRESH_CHECK_INTERVAL)
**Threshold:** Refresh when 80% of TTL has elapsed

- Calculate: `refreshTime = issuedTime + totalLifetime * 0.8`
- If `now >= refreshTime`: call `mintNodeToken()` again
- Error handling: Log error, continue (don't throw)

### 8.4 Caller Token Validation

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:192–232`

**Called by:** `getNetworkClient()`, `getDataChannelClient()`, `getIBGPClient()` before returning client

**Process:**

1. If no auth client configured: return `{ valid: true }` (allow, for testing)
2. Call `authClient.permissions(callerToken)`
3. If error: return `{ valid: false, error }`
4. Call `permissionsApi.authorizeAction()`
   - **Context:** `{ action: string, nodeContext: { nodeId, domains } }`
   - **Actions:** `'PEER_CREATE'`, `'ROUTE_CREATE'`, `'IBGP_CONNECT'`
5. Check result: `{ success: true, allowed: boolean }` or error
6. Return: `{ valid: true }` if allowed, else `{ valid: false, error }`

---

## 9. Connection Pool

### 9.1 ConnectionPool Class

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:77–101`

**Purpose:** Cache RPC stubs to peer orchestrators and external services (Envoy, Gateway)

**Fields:**

- `stubs: Map<string, RpcStub<PublicApi>>` — Cache by endpoint
- `type: 'ws' | 'http'` — Protocol (default: 'http')

**Methods:**

- `get(endpoint: string | undefined): RpcStub<PublicApi> | undefined`
  - Returns cached stub if exists
  - Creates and caches new stub if not
  - `newHttpBatchRpcSession()` or `newWebSocketRpcSession()` from capnweb

**Lifetime:** Stubs held until explicitly cleared (no eviction)

### 9.2 RPC Session Factories

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:69–75`

- `getHttpPeerSession(endpoint)` → `newHttpBatchRpcSession<API>(endpoint)`
- `getWebSocketPeerSession(endpoint)` → `newWebSocketRpcSession<API>(endpoint)`

(Exported for client use; orchestrator uses via ConnectionPool)

---

## 10. Configuration Schema

**Location:** `apps/orchestrator/src/v1/types.ts:6–24` and `packages/config/src/index.ts:45–66`

### 10.1 OrchestratorConfigSchema

```typescript
z.object({
  node: NodeConfigSchema.extend({
    endpoint: z.string(), // REQUIRED — orchestrator's own RPC endpoint
  }),
  gqlGatewayConfig: z
    .object({
      endpoint: z.string(),
    })
    .optional(),
  envoyConfig: z
    .object({
      endpoint: z.string(),
      envoyAddress: z.string().optional(),
      portRange: z.array(PortEntrySchema).min(1), // At least one port
    })
    .optional(),
})
```

### 10.2 NodeConfigSchema

```typescript
z.object({
  name: z.string(),
  domains: z.array(z.string()),
  endpoint: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  peerToken: z.string().optional(),
  envoyAddress: z.string().optional(),
})
```

### 10.3 PortEntry (for envoyConfig.portRange)

```typescript
z.union([
  z.number().int().min(1).max(65535), // Single port
  z.tuple([port, port]), // Range [start, end]
])
```

### 10.4 Auth Configuration

```typescript
z.object({
  endpoint: z.string(),
  systemToken: z.string(),
}).optional()
```

**Loaded from environment variables:**

- `CATALYST_NODE_ID` (required)
- `CATALYST_PEERING_ENDPOINT` (required for orchestrator)
- `CATALYST_DOMAINS` (comma-separated, optional)
- `CATALYST_ENVOY_ENDPOINT` (optional, enables Envoy sync)
- `CATALYST_ENVOY_ADDRESS` (optional)
- `CATALYST_ENVOY_PORT_RANGE` (JSON array, optional)
- `CATALYST_GQL_GATEWAY_ENDPOINT` (optional, enables GraphQL sync)
- `CATALYST_AUTH_ENDPOINT` (optional, enables auth integration)
- `CATALYST_SYSTEM_TOKEN` (required if auth enabled)

---

## 11. Logging & Telemetry

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:131`

**Logger instance:** `getLogger(['catalyst', 'orchestrator'])`

**Events logged:**

- **Info level:**
  - Action dispatch: `Dispatching action: ${action.action}`
  - Peer connection attempts/success/close
  - Route creation/deletion broadcasts
  - Gateway/Envoy sync success/failure
  - Withdrawal propagation
- **Debug level:**
  - Loop detection drops
  - Route push to peers
- **Error level:**
  - All errors in dispatch, handleNotify, connection attempts, token validation, port allocation failures
  - Critical issues: missing peerToken

**Telemetry integration:**

- Service telemetry via `OrchestratorService.telemetry`
- Token refresh logging
- Service lifecycle logging (initialize, shutdown)

---

## 12. Error Handling Strategy

### 12.1 Dispatch Pipeline Errors

- Validation errors (missing peer, duplicate route, etc.) → Return `{ success: false, error: string }`
- Caller error → HTTP error response (via RPC framework)

### 12.2 Side Effect Errors (handleNotify)

- BGP notifications: Log error, continue (fire-and-forget)
- Envoy sync: Log error, continue (fire-and-forget)
- Gateway sync: Log error, continue (fire-and-forget)
- Withdrawal propagation: Log error, continue per peer
- **No retry logic:** Errors are one-shot

### 12.3 Connection Errors

- Failed connection to peer: Log, leave peer in 'initializing' state
- Failed RPC call: Log, continue (fire-and-forget)

### 12.4 Auth Errors

- Token validation failure: Return `{ success: false, error }`
- No auth configured: Allow (development mode)
- Timeout/connection error: Return `{ success: false, error }`

### 12.5 Token Refresh Errors

- Refresh failure: Log, continue using existing token
- Service startup token minting: Throw, fail service initialization

---

## 13. Validation Rules

### 13.1 Node Configuration

**Location:** `apps/orchestrator/src/v1/orchestrator.ts:173–184`

- Node name must end with `.somebiz.local.io`
- If domains are configured, node name must match at least one domain as suffix

### 13.2 Route Names

**Location:** `packages/routing/src/v1/datachannel.ts:13–17`

- Length: 1–253 characters
- Pattern: `/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i` (alphanumeric, dots, underscores, hyphens; no leading/trailing)

### 13.3 Port Range

- Integers 1–65535
- Ranges specified as [start, end] tuples (inclusive)
- At least one port must be available

---

## 14. RPC Mounting & Server Integration

**Location:** `apps/orchestrator/src/v1/service.ts:94–99`

**Route:** `POST /rpc`

**Handler:**

```typescript
this.handler.all('/rpc', (c) =>
  newRpcResponse(c, this._bus.publicApi(), {
    upgradeWebSocket: getUpgradeWebSocket(c),
  })
)
```

**Transports:** HTTP (batch) and WebSocket (streaming) via Hono upgrade

**Framework:** capnweb (Cap'n Proto RPC over HTTP/WS)

---

## 15. State Immutability & Consistency

### 15.1 State Updates

- Dispatch always creates new state object (shallow copy with object spreads)
- No in-place mutations after committing state
- Example: `state = { ...state, internal: { ...state.internal, peers: [...] } }`

### 15.2 Concurrency

- Single-threaded (Node.js event loop)
- Concurrent dispatch calls would queue via JavaScript runtime
- No explicit locking

### 15.3 Side Effects Ordering

1. State committed first
2. Then `handleNotify()` async operations start (fire-and-forget)
3. Caller returns immediately (doesn't wait for notifications)

---

## 16. Known Limitations & Assumptions

### 16.1 Scalability

- All state in memory (single node)
- No clustering/replication
- Action log not implemented in v1
- No state persistence across restarts

### 16.2 Performance

- Linear search for peer lookups (small number assumed)
- Full route table sent to peer on every connect (no delta)
- No batching of notifications

### 16.3 Security

- `peerToken` field exposed in route metadata (filtered from public API but present in internal routes)
- No rate limiting on RPC endpoints
- Node token expiry only checked periodically (once per hour)

### 16.4 Reliability

- No retries on failed peer sync
- No heartbeat/keepalive between peers (besides new connections)
- Port allocations lost on restart (no persistence)

---

## 17. External Dependencies

### 17.1 Packages

- `@catalyst/routing/v1` — Action types, state schemas, message formats
- `@catalyst/config` — NodeConfigSchema, PortEntry, config loading
- `@catalyst/telemetry` — Logger, metrics, tracing
- `@catalyst/service` — CatalystService base class, lifecycle
- `@catalyst/authorization` — Principal types
- `@catalyst/envoy-service` — PortAllocator interface, createPortAllocator factory
- `capnweb` — RPC stubs (newHttpBatchRpcSession, newWebSocketRpcSession)
- `@hono/capnweb` — newRpcResponse handler
- `zod` — Schema validation

### 17.2 RPC Targets

- Auth service (minting tokens, validating permissions)
- Peer orchestrators (connecting, syncing routes)
- Envoy service (updating routes)
- GraphQL gateway (updating services)

---

## 18. Public Exports (v1/index.ts)

**Location:** `apps/orchestrator/src/v1/index.ts`

**Classes:**

- `CatalystNodeBus` — Core orchestrator
- `ConnectionPool` — RPC stub cache
- `OrchestratorService` — Service wrapper

**Functions:**

- `getHttpPeerSession(endpoint)` — Create HTTP RPC session
- `getWebSocketPeerSession(endpoint)` — Create WebSocket RPC session

**Types:**

- `PublicApi` — RPC API interface
- `NetworkClient` — Peer management client
- `DataChannel` — Route management client
- `IBGPClient` — iBGP protocol client
- `PeerInfo`, `InternalRoute` — State types
- `OrchestratorConfig` — Configuration type
- `StateResult`, `NotificationResult` — Result types
- `DataChannelDefinition` — Route type (re-exported from routing)

---

## 19. Capability Matrix

| Capability                    | Implemented | Status          |
| ----------------------------- | ----------- | --------------- |
| Peer management (CRUD)        | ✅ Yes      | Full            |
| Local route management (CRUD) | ✅ Yes      | Full            |
| iBGP initial sync             | ✅ Yes      | Full            |
| iBGP delta fan-out            | ✅ Yes      | Full            |
| Route propagation             | ✅ Yes      | Full            |
| Loop detection                | ✅ Yes      | Full            |
| Split-horizon filtering       | ✅ Yes      | Full            |
| Multi-hop port rewriting      | ✅ Yes      | Full            |
| Envoy integration             | ✅ Yes      | Full            |
| GraphQL gateway sync          | ✅ Yes      | Full            |
| Auth integration              | ✅ Yes      | Full            |
| Token minting                 | ✅ Yes      | Full            |
| Token refresh                 | ✅ Yes      | Full            |
| Caller validation             | ✅ Yes      | Full            |
| RPC API                       | ✅ Yes      | Full            |
| Telemetry                     | ✅ Yes      | Basic (logging) |
| Persistence                   | ❌ No       | N/A             |
| Keepalive/hold timers         | ❌ No       | N/A             |
| State replication             | ❌ No       | N/A             |
| Graceful shutdown             | ✅ Yes      | Partial         |

---

## 20. Integration Points for V2 Gap Analysis

**Compare against these v1 capabilities in v2:**

1. **Action dispatch pipeline** — v1 uses `handleAction()` + `handleNotify()` separation
2. **State structure** — v1 uses simple RouteTable with local/internal split
3. **BGP protocol** — v1 has full delta fan-out and propagation (look for holdtimers, keepalive in v2)
4. **Port allocation** — v1 uses PortAllocator; v2 may have different strategy
5. **Auth flow** — v1 mints node token on startup, validates callers per RPC
6. **Configuration** — v1 expects OrchestratorConfig with node/gqlGateway/envoy sections
7. **RPC endpoints** — v1 mounts at `/rpc` with three client getters
8. **Error handling** — v1 uses fire-and-forget for notifications (v2 may differ)
9. **Loop detection** — v1 checks nodePath against this.config.node.name
10. **Multi-hop rewriting** — v1 uses egress port keys for port allocation; v2 may differ
