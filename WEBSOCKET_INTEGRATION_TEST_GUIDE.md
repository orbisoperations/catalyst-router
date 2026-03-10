# WebSocket Integration Test Guide for v2 Orchestrator

## Quick Architecture

The orchestrator v2 stack for integration testing:

```
CatalystHonoServer (HTTP + WebSocket)
        ↓
  OrchestratorService (RPC endpoint at /rpc)
        ↓
  OrchestratorServiceV2 (bus + tick + reconnect)
        ↓
    OrchestratorBus (RIB + dispatch queue)
        ↓
   PeerTransport (WebSocketPeerTransport in prod, MockPeerTransport in unit tests)
```

## Port Allocation

Use dynamic allocation to avoid conflicts:

```typescript
// Option 1: Port 0 (true ephemeral)
const server = new CatalystHonoServer(handler, { port: 0 })
await server.start()
const actualPort = server.port // Read after start

// Option 2: Incrementing high ports (for visual clarity in debugging)
let nextPort = 19_100
const server = new CatalystHonoServer(handler, { port: nextPort++ })
```

Always call `await server.stop()` in `afterEach` cleanup.

## Server Lifecycle

```typescript
import { CatalystHonoServer } from '@catalyst/service'

let server: CatalystHonoServer

beforeEach(async () => {
  const handler = new Hono()
  handler.route('/path', service.handler)
  server = new CatalystHonoServer(handler, { port: 0 })
  await server.start()
  // server.port is now available
})

afterEach(async () => {
  await server.stop() // Force-closes connections, waits for shutdown
})
```

## RPC Client Creation

Two patterns:

### Production Pattern (WebSocket to real server)

```typescript
import { newWebSocketRpcSession } from 'capnweb'
import type { IBGPClient } from '../../src/v2/rpc.js'

const endpoint = `ws://localhost:${port}/rpc`
const stub = newWebSocketRpcSession(endpoint)
const result = await stub.getIBGPClient(tokenString)
if (!result.success) throw new Error(result.error)
const client: IBGPClient = result.client
await client.open({ peerInfo, holdTime: 90_000 })
```

### Unit Test Pattern (Direct dispatch, no WebSocket)

```typescript
import { OrchestratorBus, MockPeerTransport } from '../../src/v2/index.js'
import { createIBGPClient } from '../../src/v2/rpc.js'

const transport = new MockPeerTransport()
const bus = new OrchestratorBus({ config, transport })
const result = await createIBGPClient(bus, token, validator)
const client = result.client
await client.open({ peerInfo })
```

## Token Validation

All RPC calls require token validation at two gates:

1. **Factory gate** (creates the client):

   ```typescript
   const result = await createIBGPClient(bus, token, validator)
   // Returns { success: false, error } if validation fails
   ```

2. **Method gate** (verifies identity):
   - `peerInfo.name` must match JWT `sub` claim
   - `update()`: All `nodePath[0]` must match authenticated identity
   - Prevents peer impersonation and route injection

For tests, provide a mock validator:

```typescript
const allowAllValidator = {
  async validateToken() {
    return { valid: true }
  },
}
```

Or create test tokens with `SignJWT`:

```typescript
import { SignJWT } from 'jose'

const token = await new SignJWT({ sub: 'node-b' })
  .setProtectedHeader({ alg: 'HS256' })
  .sign(testSecret)
```

## Keepalive Testing

### Direct (Unit Test)

```typescript
const bus = new OrchestratorBus({ config, transport: new MockPeerTransport() })
await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
await bus.dispatch({ action: Actions.InternalProtocolConnected, data: { peerInfo } })

const peer = bus.state.internal.peers.find((p) => p.name === 'node-b')
const now = peer.lastReceived + Math.floor(peer.holdTime / 3) + 1

// Trigger keepalive via Tick
await bus.dispatch({ action: Actions.Tick, data: { now } })

// Verify transport call
const keepaliveCalls = transport.getCallsFor('sendKeepalive')
expect(keepaliveCalls).toHaveLength(1)
```

### Topology (Multi-node Unit Test)

```typescript
const topo = new TopologyHelper()
topo.addNode('node-a')
topo.addNode('node-b')
await topo.peer('node-a', 'node-b')

// Simulate keepalive exchange
// Use propagate() to deliver updates between nodes
```

See `apps/orchestrator/tests/v2/keepalive.topology.test.ts` for full patterns.

## Full Integration Test Skeleton

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { newWebSocketRpcSession } from 'capnweb'
import { CatalystHonoServer } from '@catalyst/service'
import { OrchestratorService } from '../../src/v2/catalyst-service.js'
import type { IBGPClient } from '../../src/v2/rpc.js'
import type { OrchestratorConfig } from '../../src/v1/types.js'

describe('Orchestrator v2 WebSocket Integration', () => {
  let portA: number
  let serverA: CatalystHonoServer
  let orchestratorA: OrchestratorService

  let portB: number
  let serverB: CatalystHonoServer
  let orchestratorB: OrchestratorService

  const configA: OrchestratorConfig = {
    node: {
      name: 'node-a',
      endpoint: 'ws://localhost:PORT_A',
      domains: ['test.local'],
    },
  }

  const configB: OrchestratorConfig = {
    node: {
      name: 'node-b',
      endpoint: 'ws://localhost:PORT_B',
      domains: ['test.local'],
    },
  }

  beforeEach(async () => {
    // Start Node A
    orchestratorA = new OrchestratorService({ config: configA })
    serverA = new CatalystHonoServer(orchestratorA.handler, { port: 0 })
    await serverA.start()
    portA = serverA.port

    // Start Node B
    orchestratorB = new OrchestratorService({ config: configB })
    serverB = new CatalystHonoServer(orchestratorB.handler, { port: 0 })
    await serverB.start()
    portB = serverB.port
  })

  afterEach(async () => {
    await serverA.stop()
    await serverB.stop()
  })

  it('connects two orchestrators via WebSocket RPC', async () => {
    // Create RPC client to Node A
    const endpointA = `ws://localhost:${portA}/rpc`
    const stubA = newWebSocketRpcSession(endpointA)

    // Mock token for testing (would come from auth service in production)
    const mockToken = 'test-token-node-b'

    // Get iBGP client from Node A (with mocked validation in the service)
    const result = await stubA.getIBGPClient(mockToken)
    if (!result.success) {
      throw new Error(`Failed to get iBGP client: ${result.error}`)
    }

    const client: IBGPClient = result.client

    // Open session to Node B
    const peerBInfo = {
      name: 'node-b',
      endpoint: `ws://localhost:${portB}/rpc`,
      domains: ['test.local'],
    }

    const openResult = await client.open({
      peerInfo: peerBInfo,
      holdTime: 90_000,
    })

    expect(openResult.success).toBe(true)

    // Verify connection state in Node A's bus
    const peer = orchestratorA.v2.bus.state.internal.peers.find((p) => p.name === 'node-b')
    expect(peer).toBeDefined()
    expect(peer?.connectionStatus).toBe('connected')
  })

  it('propagates routes from A to B', async () => {
    // Peer A↔B first
    // Then create route at A and verify it appears at B
    // Uses RPC sendUpdate → captured by B's incoming update handler
  })

  it('sends keepalives and detects disconnection', async () => {
    // Peer nodes, verify keepalive flow
    // Simulate missed keepalive, verify hold timer expiry
  })
})
```

## Key Files

| Component              | Path                                           |
| ---------------------- | ---------------------------------------------- |
| OrchestratorService    | `apps/orchestrator/src/v2/catalyst-service.ts` |
| OrchestratorServiceV2  | `apps/orchestrator/src/v2/service.ts`          |
| OrchestratorBus        | `apps/orchestrator/src/v2/bus.ts`              |
| TickManager            | `apps/orchestrator/src/v2/tick-manager.ts`     |
| ReconnectManager       | `apps/orchestrator/src/v2/reconnect.ts`        |
| WebSocketPeerTransport | `apps/orchestrator/src/v2/ws-transport.ts`     |
| MockPeerTransport      | `apps/orchestrator/src/v2/transport.ts`        |
| RPC Factories          | `apps/orchestrator/src/v2/rpc.ts`              |
| CatalystHonoServer     | `packages/service/src/catalyst-hono-server.ts` |

## Example Tests

See `apps/orchestrator/tests/v2/`:

- `service.test.ts` — OrchestratorServiceV2 lifecycle
- `orchestrator.topology.test.ts` — Multi-node routing (no real WebSocket)
- `keepalive.topology.test.ts` — Keepalive behavior
- `rpc.test.ts` — Token validation and identity checks

And `packages/service/tests/catalyst-hono-server.test.ts` for server lifecycle patterns.

## Testing Strategies

### Strategy 1: Pure Unit Tests (MockPeerTransport)

- Create bus instances directly
- Use MockPeerTransport to record calls
- Assert internal state changes
- **Fast, deterministic, no network**

### Strategy 2: Topology Tests (TopologyHelper)

- Multiple bus instances wired together
- Explicit propagation via TopologyHelper.propagate()
- Simulate multi-hop routing
- **Still fast, tests routing logic without WebSocket**

### Strategy 3: Integration Tests (Real WebSocket)

- Start CatalystHonoServer instances
- Connect via WebSocket RPC clients
- Full dispatch → transport → remote bus cycle
- **Slower, real network overhead, but tests actual wiring**

Use all three levels:

1. **Unit**: Test action dispatch logic (fast)
2. **Topology**: Test multi-node routing (fast)
3. **Integration**: Test RPC wiring end-to-end (slow, but catches real issues)

## Troubleshooting

### "Port X already in use"

- Use port 0 for ephemeral allocation
- Or increase the starting port in your sequential allocator
- Check `lsof -i :PORT` to see what's listening

### "upgradeWebSocket is not available"

- Ensure you're using `getUpgradeWebSocket(c)` inside a Hono handler
- Not `upgradeWebSocket` directly (deprecated module-level singleton)

### Token validation errors in tests

- Verify JWT `sub` claim matches `peerInfo.name`
- Check validator implementation (allowAllValidator for tests)
- Sign test tokens with consistent secret

### RPC stub times out

- Verify server is running: `await server.start()` completed
- Check port: Endpoint must match `ws://localhost:${port}/rpc`
- Verify handler is mounted: `app.all('/rpc', ...)`

### Keepalive not sending

- Verify peer is in `connectionStatus: 'connected'` state
- Verify `holdTime > 0` on peer
- Inject `now` timestamp past `lastReceived + holdTime/3` in Tick action
