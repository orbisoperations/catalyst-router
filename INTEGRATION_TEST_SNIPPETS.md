# Integration Test Code Snippets

Copy-paste ready patterns for v2 orchestrator WebSocket testing.

## Setup: Two Orchestrators Over WebSocket

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CatalystHonoServer } from '@catalyst/service'
import { OrchestratorService } from '../../src/v2/catalyst-service.js'
import { newWebSocketRpcSession } from 'capnweb'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { IBGPClient } from '../../src/v2/rpc.js'

// Port allocator
let nextPort = 19_100
function getPort(): number {
  return nextPort++
}

describe('Two-node WebSocket topology', () => {
  const configA: OrchestratorConfig = {
    node: { name: 'node-a', endpoint: '', domains: ['test.local'] },
  }
  const configB: OrchestratorConfig = {
    node: { name: 'node-b', endpoint: '', domains: ['test.local'] },
  }

  let portA: number
  let portB: number
  let serverA: CatalystHonoServer
  let serverB: CatalystHonoServer
  let orchestratorA: OrchestratorService
  let orchestratorB: OrchestratorService

  beforeEach(async () => {
    // Node A
    portA = getPort()
    configA.node.endpoint = `ws://localhost:${portA}/rpc`
    orchestratorA = new OrchestratorService({ config: configA })
    serverA = new CatalystHonoServer(orchestratorA.handler, { port: portA })
    await serverA.start()

    // Node B
    portB = getPort()
    configB.node.endpoint = `ws://localhost:${portB}/rpc`
    orchestratorB = new OrchestratorService({ config: configB })
    serverB = new CatalystHonoServer(orchestratorB.handler, { port: portB })
    await serverB.start()
  })

  afterEach(async () => {
    await serverA.stop()
    await serverB.stop()
  })

  // Tests go here
})
```

## Test: Connect Two Nodes

```typescript
it('connects two nodes via WebSocket', async () => {
  const endpointA = `ws://localhost:${portA}/rpc`
  const stubA = newWebSocketRpcSession(endpointA)

  // In production, this token comes from auth service
  // For tests, bypass token validation by mocking validator in OrchestratorService
  const testToken = 'test-token'

  const result = await stubA.getIBGPClient(testToken)
  if (!result.success) throw new Error(result.error)

  const peerBInfo = {
    name: 'node-b',
    endpoint: `ws://localhost:${portB}/rpc`,
    domains: ['test.local'],
  }

  const openResult = await result.client.open({
    peerInfo: peerBInfo,
    holdTime: 90_000,
  })

  expect(openResult.success).toBe(true)

  // Verify connection state
  const peer = orchestratorA.v2.bus.state.internal.peers.find((p) => p.name === 'node-b')
  expect(peer?.connectionStatus).toBe('connected')
})
```

## Test: Create Route at A, Verify at B

```typescript
it('propagates route from A to B', async () => {
  // Step 1: Connect nodes
  const stubA = newWebSocketRpcSession(`ws://localhost:${portA}/rpc`)
  const clientResult = await stubA.getIBGPClient('token')
  if (!clientResult.success) throw new Error('Failed')

  const peerBInfo = {
    name: 'node-b',
    endpoint: `ws://localhost:${portB}/rpc`,
    domains: ['test.local'],
  }
  const openResult = await clientResult.client.open({ peerInfo: peerBInfo })
  expect(openResult.success).toBe(true)

  // Step 2: Trigger connection ready (may be automatic, but explicit for clarity)
  const peerAInfo = {
    name: 'node-a',
    endpoint: `ws://localhost:${portA}/rpc`,
    domains: ['test.local'],
  }
  await orchestratorB.v2.bus.dispatch({
    action: 'InternalProtocolConnected', // From routing/v2
    data: { peerInfo: peerAInfo },
  })

  // Step 3: Create route at A via RPC
  const dcResult = await stubA.getDataChannelClient('token')
  if (!dcResult.success) throw new Error('Failed')

  const routeX = {
    name: 'service-x',
    protocol: 'http' as const,
    endpoint: 'http://svc-x:8080',
  }

  const addResult = await dcResult.client.addRoute(routeX)
  expect(addResult.success).toBe(true)

  // Step 4: Wait for propagation (may need small delay for async dispatch)
  await new Promise((r) => setTimeout(r, 100))

  // Step 5: Verify route appears at B
  const routesB = orchestratorB.v2.bus.state.internal.routes
  expect(routesB.some((r) => r.name === 'service-x')).toBe(true)
})
```

## Test: Keepalive Exchange

```typescript
it('sends keepalive on schedule', async () => {
  // Connect nodes first
  const stub = newWebSocketRpcSession(`ws://localhost:${portA}/rpc`)
  const result = await stub.getIBGPClient('token')
  if (!result.success) throw new Error('Failed')

  const peerBInfo = {
    name: 'node-b',
    endpoint: `ws://localhost:${portB}/rpc`,
    domains: ['test.local'],
  }
  const openResult = await result.client.open({ peerInfo: peerBInfo, holdTime: 90_000 })
  expect(openResult.success).toBe(true)

  // Get reference to peer
  const peer = orchestratorA.v2.bus.state.internal.peers.find((p) => p.name === 'node-b')
  expect(peer).toBeDefined()

  // Spy on transport to count keepalive sends
  const transport = (orchestratorA.v2.bus as any).transport // access private for test
  const openSpy = vi.spyOn(transport, 'sendKeepalive')

  // Dispatch Tick that should trigger keepalive (past holdTime/3)
  const now = peer!.lastReceived + Math.floor(peer!.holdTime / 3) + 1000
  await orchestratorA.v2.bus.dispatch({
    action: 'Tick', // From routing/v2
    data: { now },
  })

  // Verify keepalive was sent
  expect(openSpy).toHaveBeenCalledWith(peer)
})
```

## Test: Mock Token Validation (Bypass Auth)

For integration tests that don't have auth service running:

```typescript
// In test setup, before starting server:
import { OrchestratorService } from '../../src/v2/catalyst-service.js'

// Option 1: Use a config without auth
const configNoAuth: OrchestratorConfig = {
  node: { name: 'node-a', endpoint: '...', domains: ['test.local'] },
  // orchestrator.auth is undefined — token validation will always fail
}

// Option 2: Create OrchestratorService and override token validation
class MockOrchestratorService extends OrchestratorService {
  protected buildTokenValidator() {
    return {
      async validateToken() {
        return { valid: true } // Accept all tokens
      },
    }
  }
}

const orchestratorA = new MockOrchestratorService({ config: configA })
```

Or patch the service after construction:

```typescript
const orchestratorA = new OrchestratorService({ config: configA })

// Monkey-patch: Override token validation
const originalBuildValidator = (orchestratorA as any).buildTokenValidator
;(orchestratorA as any).buildTokenValidator = () => ({
  async validateToken() {
    return { valid: true }
  },
})

// Now start server
const serverA = new CatalystHonoServer(orchestratorA.handler, { port: portA })
await serverA.start()
```

## Test: Direct Unit Test (No WebSocket)

For fast testing without real servers:

```typescript
import { OrchestratorBus, MockPeerTransport } from '../../src/v2/index.js'
import { createIBGPClient } from '../../src/v2/rpc.js'
import { Actions } from '@catalyst/routing/v2'

describe('Direct bus dispatch (no WebSocket)', () => {
  const config: OrchestratorConfig = {
    node: { name: 'node-a', endpoint: 'ws://node-a:4000', domains: ['test.local'] },
  }

  const transport = new MockPeerTransport()
  const bus = new OrchestratorBus({ config, transport })

  const allowAllValidator = {
    async validateToken() {
      return { valid: true }
    },
  }

  it('dispatches actions directly to bus', async () => {
    const peerInfo = { name: 'node-b', endpoint: 'ws://node-b:4000', domains: ['test.local'] }

    // Create peer
    const result = await bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: peerInfo,
    })

    expect(result.success).toBe(true)
    expect(bus.state.internal.peers).toHaveLength(1)
  })

  it('records transport calls', async () => {
    const peerInfo = { name: 'node-b', endpoint: 'ws://node-b:4000', domains: ['test.local'] }

    // Create and connect peer
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo },
    })

    // Create route — should trigger sendUpdate to transport
    const route = { name: 'api', protocol: 'http' as const, endpoint: 'http://api:8080' }
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: route,
    })

    // Verify transport recorded the update
    const updateCalls = transport.getCallsFor('sendUpdate')
    expect(updateCalls.length).toBeGreaterThan(0)
  })

  it('uses RPC factories directly', async () => {
    const peerInfo = { name: 'node-b', endpoint: 'ws://node-b:4000', domains: ['test.local'] }
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })

    // Create iBGP client directly (no WebSocket)
    const clientResult = await createIBGPClient(bus, 'token', allowAllValidator)
    expect(clientResult.success).toBe(true)

    const client = clientResult.client
    const openResult = await client.open({ peerInfo })
    expect(openResult.success).toBe(true)

    // Verify bus state
    const peer = bus.state.internal.peers.find((p) => p.name === 'node-b')
    expect(peer?.connectionStatus).toBe('connected')
  })
})
```

## Test: Topology Helper (Multi-node, No WebSocket)

For testing complex routing without real servers:

```typescript
import { TopologyHelper } from '../v2/orchestrator.topology.test.js'

it('routes propagate correctly in A↔B↔C chain', async () => {
  const topo = new TopologyHelper()

  // Create 3 nodes
  topo.addNode('node-a')
  topo.addNode('node-b')
  topo.addNode('node-c')

  // Wire: A↔B and B↔C (linear chain)
  await topo.peer('node-a', 'node-b')
  await topo.peer('node-b', 'node-c')

  topo.resetAll() // Clear transport call history

  // A creates a route
  const route = { name: 'svc', protocol: 'http' as const, endpoint: 'http://svc:8080' }
  await topo.get('node-a').bus.dispatch({
    action: Actions.LocalRouteCreate,
    data: route,
  })

  // Propagate A→B
  await topo.propagate('node-a', 'node-b')

  // Verify B has it
  expect(topo.get('node-b').bus.state.internal.routes.some((r) => r.name === 'svc')).toBe(true)

  // Propagate B→C
  await topo.propagate('node-b', 'node-c')

  // Verify C has it with correct path
  const routeAtC = topo.get('node-c').bus.state.internal.routes.find((r) => r.name === 'svc')
  expect(routeAtC).toBeDefined()
  expect(routeAtC?.nodePath).toEqual(['node-b', 'node-a']) // B prepends itself
})
```

## Test: Verify Loop Prevention

```typescript
it('prevents route loops in mesh topology', async () => {
  const topo = new TopologyHelper()

  // Create full mesh: A↔B, A↔C, B↔C
  topo.addNode('node-a')
  topo.addNode('node-b')
  topo.addNode('node-c')

  await topo.peer('node-a', 'node-b')
  await topo.peer('node-a', 'node-c')
  await topo.peer('node-b', 'node-c')

  topo.resetAll()

  // A creates route
  const route = { name: 'svc', protocol: 'http' as const, endpoint: 'http://svc:8080' }
  await topo.get('node-a').bus.dispatch({
    action: Actions.LocalRouteCreate,
    data: route,
  })

  // Propagate to B and C
  await topo.propagate('node-a', 'node-b')
  await topo.propagate('node-a', 'node-c')

  topo.resetAll()

  // Now B tries to forward to C
  await topo.propagate('node-b', 'node-c')

  // C should keep shorter direct path from A, not longer path from B
  const routeAtC = topo.get('node-c').bus.state.internal.routes.find((r) => r.name === 'svc')
  expect(routeAtC?.nodePath).toEqual(['node-a']) // Direct, not ['node-b', 'node-a']

  // A should NOT receive the route back from B (loop prevention)
  topo.resetAll()
  await topo.propagate('node-b', 'node-a')

  const routeBackAtA = topo.get('node-a').bus.state.internal.routes.find((r) => r.name === 'svc')
  expect(routeBackAtA).toBeUndefined() // A's own local route doesn't loop back
})
```

## Test: Hold Timer Expiry

```typescript
it('expires disconnected peers on hold timer', async () => {
  const transport = new MockPeerTransport()
  const config: OrchestratorConfig = {
    node: { name: 'node-a', endpoint: 'ws://node-a:4000', domains: ['test.local'] },
  }
  const bus = new OrchestratorBus({ config, transport })

  const peerInfo = { name: 'node-b', endpoint: 'ws://node-b:4000', domains: ['test.local'] }

  // Create peer with holdTime
  await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
  await bus.dispatch({
    action: Actions.InternalProtocolOpen,
    data: { peerInfo, holdTime: 30_000 },
  })
  await bus.dispatch({
    action: Actions.InternalProtocolConnected,
    data: { peerInfo },
  })

  // Verify peer is connected
  let peer = bus.state.internal.peers.find((p) => p.name === 'node-b')
  expect(peer?.connectionStatus).toBe('connected')

  // Tick just before hold timer expires (should not close)
  const nearExpiry = peer!.lastReceived + peer!.holdTime - 1000
  await bus.dispatch({ action: Actions.Tick, data: { now: nearExpiry } })

  peer = bus.state.internal.peers.find((p) => p.name === 'node-b')
  expect(peer?.connectionStatus).toBe('connected')

  // Tick past hold timer (should close)
  const pastExpiry = peer!.lastReceived + peer!.holdTime + 1000
  await bus.dispatch({ action: Actions.Tick, data: { now: pastExpiry } })

  peer = bus.state.internal.peers.find((p) => p.name === 'node-b')
  expect(peer?.connectionStatus).toBe('closed')
})
```

## Cleanup Checklist

```typescript
describe('Integration tests', () => {
  const servers: CatalystHonoServer[] = []

  beforeEach(() => {
    vi.useFakeTimers() // If using time-dependent tests
  })

  afterEach(async () => {
    // Stop all servers
    for (const server of servers) {
      try {
        await server.stop()
      } catch (e) {
        console.error('Error stopping server:', e)
      }
    }
    servers.length = 0

    vi.useRealTimers()
  })

  // Tests...
})
```

---

**Key Points**:

1. Always use `port: 0` or incrementing ports (19_000+)
2. Always call `await server.stop()` in afterEach
3. For token validation, use allowAllValidator in tests or mock OrchestratorService
4. WebSocket RPC uses capnweb: `newWebSocketRpcSession(endpoint)`
5. For keepalive tests, dispatch Tick with `now` past `lastReceived + holdTime/3`
6. For multi-node tests without WebSocket, use TopologyHelper or direct dispatch
7. Mock transport records all calls: `transport.getCallsFor('method')`
