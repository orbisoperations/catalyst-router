# Wide Events / Logging Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert all WideEvent call sites to pure accumulation (Option A), refactor views.ts to plain functions with zod, and move dashboard links to a config file.

**Architecture:** Six stacked PRs. PR 1 (views.ts refactor) goes first because PR 4 (orchestrator v2) touches the same consumers. PRs 2-3 (gateway/envoy) are independent. PR 6 (dashboard links) is independent.

**Tech Stack:** TypeScript, zod, Hono, graphql-yoga, capnweb, Graphite (gt) for VCS

**Spec:** `docs/superpowers/specs/2026-03-12-wide-events-logging-cleanup-design.md`

---

## File Structure

**PR 1 — views.ts refactor:**

- Modify: `packages/routing/src/v2/views.ts`
- Modify: `packages/routing/tests/v2/views.test.ts`
- Modify: `apps/orchestrator/src/v2/bus.ts` (consumers)
- Modify: `apps/orchestrator/src/v2/rpc.ts` (consumers)
- Modify: `apps/orchestrator/src/v2/catalyst-service.ts` (consumers)

**PR 2 — Gateway WideEvent cleanup:**

- Modify: `apps/gateway/src/graphql/server.ts`

**PR 3 — Envoy WideEvent cleanup:**

- Modify: `apps/envoy/src/rpc/server.ts`

**PR 4 — Orchestrator v2 WideEvent cleanup:**

- Modify: `apps/orchestrator/src/v2/ws-transport.ts`
- Modify: `apps/orchestrator/src/v2/bus.ts`

**PR 5 — Orchestrator v1 WideEvent cleanup:**

- Modify: `apps/orchestrator/src/v1/orchestrator.ts`

**PR 6 — Dashboard links config file:**

- Create: `docker-compose/dashboard-links.json`
- Modify: `packages/config/src/index.ts`
- Modify: `apps/web-ui/src/server.ts`
- Modify: `docker-compose/docker.compose.yaml`
- Modify: `docker-compose/two-node.compose.yaml`

---

## Chunk 1: views.ts → Plain Functions + Zod

### Task 1: Refactor views.ts from classes to functions

**Files:**

- Modify: `packages/routing/src/v2/views.ts`

- [ ] **Step 1: Rewrite views.ts with plain functions**

Replace the entire file with:

```typescript
import { z } from 'zod'
import { type DataChannelDefinition } from './datachannel.js'
import { PeerRecordSchema, type PeerRecord, type InternalRoute, type RouteTable } from './state.js'

// ---------------------------------------------------------------------------
// Public schemas & types — safe for API exposure
// ---------------------------------------------------------------------------

/** Public peer shape — credentials and internal bookkeeping stripped. */
export const PublicPeerSchema = PeerRecordSchema.omit({
  peerToken: true,
  holdTime: true,
  lastSent: true,
  lastReceived: true,
})
export type PublicPeer = z.infer<typeof PublicPeerSchema>

/** Public internal route shape — credentials and internal flags stripped. */
export type PublicInternalRoute = Omit<InternalRoute, 'isStale'> & {
  peer: Omit<InternalRoute['peer'], 'peerToken'>
}

/** Public route table — safe for API exposure. */
export type PublicRouteTable = {
  routes: {
    local: DataChannelDefinition[]
    internal: PublicInternalRoute[]
  }
  peers: PublicPeer[]
}

// ---------------------------------------------------------------------------
// Transform functions
// ---------------------------------------------------------------------------

/** Returns peer data safe for API exposure (credentials + bookkeeping stripped). */
export function toPublicPeer(peer: PeerRecord): PublicPeer {
  const { peerToken: _token, holdTime: _hold, lastSent: _sent, lastReceived: _recv, ...rest } = peer
  return rest
}

/** Returns route safe for API exposure (peer credentials + isStale stripped). */
export function toPublicInternalRoute(route: InternalRoute): PublicInternalRoute {
  const { peerToken: _, ...safePeer } = route.peer
  const { isStale: _stale, ...rest } = route
  return { ...rest, peer: safePeer }
}

/** Returns only DataChannelDefinition fields (strips peer, nodePath, originNode, isStale). */
export function toDataChannel(route: DataChannelDefinition | InternalRoute): DataChannelDefinition {
  return {
    name: route.name,
    protocol: route.protocol,
    endpoint: route.endpoint,
    region: route.region,
    tags: route.tags,
    envoyPort: route.envoyPort,
  }
}

/** Returns the full route table safe for API exposure. */
export function toPublicRouteTable(state: RouteTable): PublicRouteTable {
  const internalRoutes: PublicInternalRoute[] = []
  for (const innerMap of state.internal.routes.values()) {
    for (const r of innerMap.values()) {
      internalRoutes.push(toPublicInternalRoute(r))
    }
  }
  return {
    routes: {
      local: [...state.local.routes.values()],
      internal: internalRoutes,
    },
    peers: [...state.internal.peers.values()].map(toPublicPeer),
  }
}

/** Total number of internal routes across all peers. */
export function internalRouteCount(state: RouteTable): number {
  return [...state.internal.routes.values()].reduce((n, m) => n + m.size, 0)
}
```

- [ ] **Step 2: Run the typecheck to verify views.ts compiles**

```bash
pnpm --filter @catalyst/routing exec tsc --noEmit
```

Expected: Type errors in consumers (bus.ts, rpc.ts, catalyst-service.ts) since classes no longer exist — that's expected and fixed in Task 2.

- [ ] **Step 3: Commit**

```bash
git add packages/routing/src/v2/views.ts
gt modify --no-interactive -c -m "refactor(routing): replace view classes with plain functions + zod"
```

---

### Task 2: Update consumers to use new function API

**Files:**

- Modify: `apps/orchestrator/src/v2/bus.ts`
- Modify: `apps/orchestrator/src/v2/rpc.ts`
- Modify: `apps/orchestrator/src/v2/catalyst-service.ts`

- [ ] **Step 1: Update bus.ts imports and usages**

In `apps/orchestrator/src/v2/bus.ts`, replace the imports:

```typescript
// OLD
import {
  RoutingInformationBase,
  ActionQueue,
  Actions,
  InternalRouteView,
  RouteTableView,
  type Action,
  type RouteTable,
  type PlanResult,
  type RoutePolicy,
  type InternalRoute,
  type PeerRecord,
  type DataChannelDefinition,
} from '@catalyst/routing/v2'

// NEW
import {
  RoutingInformationBase,
  ActionQueue,
  Actions,
  internalRouteCount,
  toDataChannel,
  type Action,
  type RouteTable,
  type PlanResult,
  type RoutePolicy,
  type InternalRoute,
  type PeerRecord,
  type DataChannelDefinition,
} from '@catalyst/routing/v2'
```

Replace `RouteTableView` usages in `dispatch()` (two occurrences):

```typescript
// OLD
committed.local.routes.size + new RouteTableView(committed).internalRouteCount

// NEW
committed.local.routes.size + internalRouteCount(committed)
```

Replace `BusTransforms.toDataChannel` — the imported `toDataChannel` now accepts `DataChannelDefinition | InternalRoute`, so the wrapper becomes a direct delegation:

```typescript
// OLD
export const BusTransforms = {
  toDataChannel(route: DataChannelDefinition | InternalRoute): DataChannelDefinition {
    return new InternalRouteView(route as InternalRoute).toDataChannel()
  },
}

// NEW
export const BusTransforms = {
  toDataChannel(route: DataChannelDefinition | InternalRoute): DataChannelDefinition {
    return toDataChannel(route)
  },
}
```

Note: `export *` in `packages/routing/src/v2/index.ts` re-exports views.ts, so the old class exports (`PeerView`, `InternalRouteView`, `RouteTableView`) will automatically be replaced by the new function exports. No barrel file changes needed.

- [ ] **Step 2: Update rpc.ts imports and usages**

In `apps/orchestrator/src/v2/rpc.ts`, replace imports:

```typescript
// OLD
import { Actions, PeerView, InternalRouteView } from '@catalyst/routing/v2'
import type { PublicPeer, PublicInternalRoute } from '@catalyst/routing/v2'

// NEW
import { Actions, toPublicPeer, toPublicInternalRoute } from '@catalyst/routing/v2'
import type { PublicPeer, PublicInternalRoute } from '@catalyst/routing/v2'
```

Replace usages:

```typescript
// OLD
return [...bus.state.internal.peers.values()].map((p) => new PeerView(p).toPublic())
// NEW
return [...bus.state.internal.peers.values()].map(toPublicPeer)

// OLD
.map((r) => new InternalRouteView(r).toPublic()),
// NEW
.map(toPublicInternalRoute),
```

- [ ] **Step 3: Update catalyst-service.ts imports and usages**

In `apps/orchestrator/src/v2/catalyst-service.ts`, replace imports:

```typescript
// OLD
import { RouteTableView } from '@catalyst/routing/v2'

// NEW
import { toPublicRouteTable } from '@catalyst/routing/v2'
```

Replace usage:

```typescript
// OLD
return c.json(new RouteTableView(snapshot).toPublic())

// NEW
return c.json(toPublicRouteTable(snapshot))
```

- [ ] **Step 4: Verify typecheck passes**

```bash
pnpm --filter @catalyst/routing exec tsc --noEmit
pnpm --filter @catalyst/orchestrator exec tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/v2/bus.ts apps/orchestrator/src/v2/rpc.ts apps/orchestrator/src/v2/catalyst-service.ts
gt modify --no-interactive -c -m "refactor(orchestrator): update consumers to use view functions"
```

---

### Task 3: Update tests

**Files:**

- Modify: `packages/routing/tests/v2/views.test.ts`

- [ ] **Step 1: Rewrite views.test.ts to test functions**

Replace the test file — keep the same test fixtures (`makePeerRecord`, `makeInternalRoute`, `makeRouteTable`), update test bodies:

```typescript
import { describe, it, expect } from 'vitest'
import {
  toPublicPeer,
  toPublicInternalRoute,
  toDataChannel,
  toPublicRouteTable,
  internalRouteCount,
} from '../../src/v2/views.js'
import type { PeerRecord, InternalRoute, RouteTable } from '../../src/v2/index.js'

function makePeerRecord(overrides: Partial<PeerRecord> = {}): PeerRecord {
  return {
    name: 'peer-1',
    domains: ['example.com'],
    connectionStatus: 'connected',
    holdTime: 90_000,
    lastSent: 0,
    lastReceived: 1000,
    ...overrides,
  }
}

function makeInternalRoute(overrides: Partial<InternalRoute> = {}): InternalRoute {
  return {
    name: 'route-a',
    protocol: 'http',
    endpoint: 'http://a:8080',
    peer: { name: 'peer-1', domains: ['example.com'], peerToken: 'secret-token' },
    nodePath: ['peer-1'],
    originNode: 'peer-1',
    ...overrides,
  }
}

function makeRouteTable(): RouteTable {
  const routeA = makeInternalRoute()
  const routeB = makeInternalRoute({
    name: 'route-b',
    peer: { name: 'peer-2', domains: ['example.com'] },
    nodePath: ['peer-2'],
    originNode: 'peer-2',
    isStale: true,
  })
  return {
    local: {
      routes: new Map([
        [
          'local-route',
          { name: 'local-route', protocol: 'http' as const, endpoint: 'http://local:8080' },
        ],
      ]),
    },
    internal: {
      peers: new Map([
        ['peer-1', makePeerRecord({ peerToken: 'secret-1' })],
        ['peer-2', makePeerRecord({ name: 'peer-2', peerToken: 'secret-2' })],
      ]),
      routes: new Map([
        ['peer-1', new Map([[`${routeA.name}:${routeA.originNode}`, routeA]])],
        ['peer-2', new Map([[`${routeB.name}:${routeB.originNode}`, routeB]])],
      ]),
    },
  }
}

describe('toPublicPeer', () => {
  it('strips peerToken', () => {
    const peer = makePeerRecord({ peerToken: 'secret' })
    const pub = toPublicPeer(peer)
    expect(pub).not.toHaveProperty('peerToken')
    expect(pub.name).toBe('peer-1')
  })

  it('strips holdTime, lastSent, lastReceived', () => {
    const pub = toPublicPeer(makePeerRecord())
    expect(pub).not.toHaveProperty('holdTime')
    expect(pub).not.toHaveProperty('lastSent')
    expect(pub).not.toHaveProperty('lastReceived')
  })

  it('preserves name, domains, endpoint, connectionStatus', () => {
    const pub = toPublicPeer(makePeerRecord({ endpoint: 'ws://peer:4000' }))
    expect(pub.name).toBe('peer-1')
    expect(pub.domains).toEqual(['example.com'])
    expect(pub.endpoint).toBe('ws://peer:4000')
    expect(pub.connectionStatus).toBe('connected')
  })
})

describe('toPublicInternalRoute', () => {
  it('strips peerToken from peer', () => {
    const pub = toPublicInternalRoute(makeInternalRoute())
    expect(pub.peer).not.toHaveProperty('peerToken')
    expect(pub.peer.name).toBe('peer-1')
  })

  it('strips isStale', () => {
    const pub = toPublicInternalRoute(makeInternalRoute({ isStale: true }))
    expect(pub).not.toHaveProperty('isStale')
  })
})

describe('toDataChannel', () => {
  it('returns only DataChannelDefinition fields', () => {
    const route = makeInternalRoute({ region: 'us-east', tags: ['a'], envoyPort: 10000 })
    const dc = toDataChannel(route)
    expect(dc).toEqual({
      name: 'route-a',
      protocol: 'http',
      endpoint: 'http://a:8080',
      region: 'us-east',
      tags: ['a'],
      envoyPort: 10000,
    })
    expect(dc).not.toHaveProperty('peer')
    expect(dc).not.toHaveProperty('nodePath')
    expect(dc).not.toHaveProperty('originNode')
    expect(dc).not.toHaveProperty('isStale')
  })
})

describe('toPublicRouteTable', () => {
  it('strips all credentials', () => {
    const pub = toPublicRouteTable(makeRouteTable())

    for (const peer of pub.peers) {
      expect(peer).not.toHaveProperty('peerToken')
      expect(peer).not.toHaveProperty('holdTime')
      expect(peer).not.toHaveProperty('lastSent')
      expect(peer).not.toHaveProperty('lastReceived')
    }

    for (const route of pub.routes.internal) {
      expect(route.peer).not.toHaveProperty('peerToken')
      expect(route).not.toHaveProperty('isStale')
    }

    expect(pub.routes.local).toHaveLength(1)
  })

  it('preserves data integrity', () => {
    const table = makeRouteTable()
    const pub = toPublicRouteTable(table)
    expect(pub.peers).toHaveLength(2)
    expect(pub.routes.internal).toHaveLength(2)
    expect(pub.routes.local).toHaveLength(1)
    expect(pub.peers[0].name).toBe('peer-1')
    expect(pub.routes.internal[0].name).toBe('route-a')
  })
})

describe('internalRouteCount', () => {
  it('counts routes across all peers', () => {
    const table = makeRouteTable()
    expect(internalRouteCount(table)).toBe(2)
  })

  it('returns 0 for empty table', () => {
    const table: RouteTable = {
      local: { routes: new Map() },
      internal: { peers: new Map(), routes: new Map() },
    }
    expect(internalRouteCount(table)).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @catalyst/routing test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/routing/tests/v2/views.test.ts
gt modify --no-interactive -c -m "test(routing): update views tests for function-based API"
```

- [ ] **Step 4: Create the stacked branch and submit PR 1**

```bash
gt submit --no-interactive
```

---

## Chunk 2: WideEvent Cleanup — Gateway and Envoy

### Task 4: Gateway reload — pure accumulation

**Files:**

- Modify: `apps/gateway/src/graphql/server.ts`

- [ ] **Step 1: Create new branch**

```bash
gt create --no-interactive wide-event-gateway-cleanup -m "refactor(gateway): WideEvent Option A cleanup"
```

- [ ] **Step 2: Rewrite the `reload()` method**

Replace the `reload()` method in `GatewayGraphqlServer` (lines 57-141) with:

```typescript
  async reload(
    config: GatewayConfig
  ): Promise<{ success: true } | { success: false; error: string }> {
    const event = new WideEvent('gateway.reload', this.logger)
    event.set('gateway.service_count', config.services.length)
    try {
      const subschemas = await Promise.all(
        config.services.map(async (service) => {
          await this.validateServiceSdl(service.url, service.token)
          const executor = this.createRemoteExecutor(service.url, service.token)
          const schema = await this.fetchRemoteSchema(executor)
          return { schema, executor }
        })
      )

      if (subschemas.length === 0) {
        event.set('gateway.zero_services', true)
        this.createYogaInstance([
          {
            typeDefs: 'type Query { status: String }',
            resolvers: {
              Query: { status: () => 'No services configured.' },
            },
          },
        ])
      } else {
        const stitchedSchema = stitchSchemas({ subschemas })
        this.createYogaInstance({ schema: stitchedSchema })
      }

      this.reloadCounter.add(1, { result: 'success' })
      this.reloadDuration.record(event.durationMs / 1000)
      const newCount = subschemas.length
      this.activeSubgraphs.add(newCount - this.currentSubgraphCount)
      this.currentSubgraphCount = newCount

      event.set({
        'gateway.duration_ms': event.durationMs,
        'gateway.subgraph_count': subschemas.length,
      })
      return { success: true }
    } catch (error: unknown) {
      this.reloadCounter.add(1, { result: 'failure' })
      this.reloadDuration.record(event.durationMs / 1000)
      event.setError(error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      event.emit()
    }
  }
```

- [ ] **Step 3: Remove intermediate logs from `validateServiceSdl()`**

Replace the `validateServiceSdl()` method — remove the two `logger.info`/`logger.warn` calls, keep only the span logic:

```typescript
  private async validateServiceSdl(url: string, token?: string) {
    const tracer = this.telemetry.tracer
    const hostname = new URL(url).hostname
    return tracer.startActiveSpan(
      `gateway validate-sdl ${hostname}`,
      { kind: SpanKind.CLIENT, attributes: { 'url.full': url } },
      async (span) => {
        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          }
          propagation.inject(context.active(), headers)

          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ query: 'query { _sdl }' }),
          })

          if (!res.ok) {
            throw new Error(`Service returned status ${res.status}`)
          }

          const result = (await res.json()) as {
            data?: { _sdl?: string }
            errors?: { message: string }[]
          }
          if (result.errors) {
            throw new Error(result.errors.map((e) => e.message).join(', '))
          }

          const sdl = result.data?._sdl
          if (!sdl || typeof sdl !== 'string' || sdl.trim().length === 0) {
            throw new Error('Service returned empty or invalid SDL')
          }

          span.end()
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          span.recordException(error as Error)
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message,
          })
          span.end()
          throw new Error(`Service validation failed for ${url}: ${message}`)
        }
      }
    )
  }
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @catalyst/gateway test:unit
```

Expected: All tests pass.

- [ ] **Step 5: Commit and submit**

```bash
git add apps/gateway/src/graphql/server.ts
gt modify --no-interactive -c -m "refactor(gateway): WideEvent Option A cleanup"
gt submit --no-interactive
```

---

### Task 5: Envoy route update — pure accumulation

**Files:**

- Modify: `apps/envoy/src/rpc/server.ts`

- [ ] **Step 1: Create new branch**

```bash
gt create --no-interactive wide-event-envoy-cleanup -m "refactor(envoy): WideEvent Option A cleanup"
```

- [ ] **Step 2: Rewrite the `updateRoutes()` method**

Replace the `updateRoutes()` method in `EnvoyRpcServer` with:

```typescript
  async updateRoutes(config: unknown): Promise<UpdateResult> {
    const event = new WideEvent('envoy.route_update', this.logger)
    try {
      const result = RouteConfigSchema.safeParse(config)
      if (!result.success) {
        event.setError(new Error('Malformed route configuration'))
        return {
          success: false,
          error: 'Malformed route configuration received and unable to parse',
        }
      }

      this.config = result.data
      const total = this.config.local.length + this.config.internal.length
      event.set({
        'envoy.route_count': total,
        'envoy.local_count': this.config.local.length,
        'envoy.internal_count': this.config.internal.length,
      })

      if (this.snapshotCache) {
        let portAllocations: Record<string, number>

        if (result.data.portAllocations) {
          portAllocations = { ...result.data.portAllocations }
        } else {
          event.set('envoy.legacy_port_derivation', true)
          portAllocations = {}
          for (const route of this.config.local) {
            if (route.envoyPort) {
              portAllocations[route.name] = route.envoyPort
            }
          }
          for (const route of this.config.internal) {
            if (route.envoyPort) {
              const egressKey = `egress_${route.name}_via_${route.peer.name}`
              portAllocations[egressKey] = route.envoyPort
            }
          }
        }

        const snapshot = buildXdsSnapshot({
          local: this.config.local,
          internal: this.config.internal,
          portAllocations,
          bindAddress: this.bindAddress,
          version: String(++this.versionCounter),
        })

        if (this.previousSnapshot) {
          const prevClusterNames = new Set(this.previousSnapshot.clusters.map((c) => c.name))
          const newClusterNames = new Set(snapshot.clusters.map((c) => c.name))
          const clustersAdded = [...newClusterNames].filter((n) => !prevClusterNames.has(n)).length
          const clustersRemoved = [...prevClusterNames].filter((n) => !newClusterNames.has(n)).length
          event.set({
            'xds.clusters_added': clustersAdded,
            'xds.clusters_removed': clustersRemoved,
          })
        }

        this.snapshotCache.setSnapshot(snapshot)
        this.previousSnapshot = snapshot
        event.set({
          'xds.snapshot_version': snapshot.version,
          'xds.listener_count': snapshot.listeners.length,
          'xds.cluster_count': snapshot.clusters.length,
        })
      }

      return { success: true }
    } catch (error: unknown) {
      event.setError(error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      event.emit()
    }
  }
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @catalyst/envoy test:unit
```

Expected: All tests pass.

- [ ] **Step 4: Commit and submit**

```bash
git add apps/envoy/src/rpc/server.ts
gt modify --no-interactive -c -m "refactor(envoy): WideEvent Option A cleanup"
gt submit --no-interactive
```

---

## Chunk 3: WideEvent Cleanup — Orchestrator v2 and v1

### Task 6: Orchestrator v2 — ws-transport openPeer

**Files:**

- Modify: `apps/orchestrator/src/v2/ws-transport.ts`

- [ ] **Step 1: Create new branch**

```bash
gt create --no-interactive wide-event-orchestrator-v2-cleanup -m "refactor(orchestrator): WideEvent Option A cleanup for v2"
```

- [ ] **Step 2: Rewrite `openPeer()` with try/finally**

Replace the `openPeer()` method in `WebSocketPeerTransport`:

```typescript
  async openPeer(peer: PeerRecord, token: string): Promise<void> {
    const event = new WideEvent('transport.open_peer', logger)
    event.set({
      'catalyst.orchestrator.peer.name': peer.name,
      'catalyst.orchestrator.peer.endpoint': peer.endpoint,
    })
    try {
      const stub = this.getStub(this.requireEndpoint(peer))
      const result = await stub.getIBGPClient(token)
      if (!result.success) {
        throw new Error(`Failed to get iBGP client for ${peer.name}: ${result.error}`)
      }
      const openResult = await result.client.open({
        peerInfo: this.localNodeInfo,
        holdTime: peer.holdTime,
      })
      if (!openResult.success) {
        throw new Error(`Failed to open peer ${peer.name}: ${openResult.error}`)
      }
    } catch (error) {
      event.setError(error)
      throw error
    } finally {
      event.emit()
    }
  }
```

- [ ] **Step 3: Commit**

```bash
git add apps/orchestrator/src/v2/ws-transport.ts
gt modify --no-interactive -c -m "refactor(orchestrator): WideEvent cleanup for ws-transport openPeer"
```

---

### Task 7: Orchestrator v2 — bus.ts dispatch

**Files:**

- Modify: `apps/orchestrator/src/v2/bus.ts`

- [ ] **Step 1: Rewrite `dispatch()` with try/catch/finally**

Replace the `dispatch()` method. Key changes: remove intermediate `logger.info('Route table changed...')`, fold `route.trigger` into event, add try/catch/finally:

```typescript
  async dispatch(action: Action): Promise<StateResult> {
    return this.queue.enqueue(async () => {
      const event = new WideEvent('orchestrator.action', logger)
      event.set({
        'catalyst.orchestrator.action.type': action.action,
        'catalyst.orchestrator.node.name': this.config.node.name,
      })

      try {
        const plan = this.rib.plan(action, this.rib.state)

        if (!this.rib.stateChanged(plan)) {
          if (action.action === Actions.Tick) {
            await this.handleKeepalives(this.rib.state, action.data.now)
          }
          event.set('catalyst.orchestrator.action.state_changed', false)
          return { success: false, error: 'No state change' }
        }

        const committed = this.rib.commit(plan, action)

        event.set({
          'catalyst.orchestrator.action.state_changed': true,
          'catalyst.orchestrator.route.change_count': plan.routeChanges.length,
          'catalyst.orchestrator.route.total':
            committed.local.routes.size + internalRouteCount(committed),
        })

        if (plan.routeChanges.length > 0) {
          const counts = { added: 0, removed: 0, modified: 0 }
          for (const c of plan.routeChanges) {
            if (c.type === 'added') counts.added++
            else if (c.type === 'removed') counts.removed++
            else counts.modified++
          }
          event.set({
            'catalyst.orchestrator.route.added': counts.added,
            'catalyst.orchestrator.route.removed': counts.removed,
            'catalyst.orchestrator.route.modified': counts.modified,
            'catalyst.orchestrator.route.trigger': action.action,
          })
        }

        await this.handlePostCommit(action, plan, committed)

        return { success: true, state: committed, action }
      } catch (error) {
        event.setError(error)
        throw error
      } finally {
        event.emit()
      }
    })
  }
```

- [ ] **Step 2: Commit**

```bash
git add apps/orchestrator/src/v2/bus.ts
gt modify --no-interactive -c -m "refactor(orchestrator): WideEvent cleanup for v2 dispatch"
```

---

### Task 8: Orchestrator v2 — bus.ts peer_sync and syncRoutesToPeer

**Files:**

- Modify: `apps/orchestrator/src/v2/bus.ts`

- [ ] **Step 1: Change `syncRoutesToPeer()` return type and remove intermediate logs**

Replace `syncRoutesToPeer()` — change return type from `Promise<void>` to `Promise<{ routeCount: number }>`, remove the 3 intermediate `logger.*` calls:

```typescript
  private async syncRoutesToPeer(
    peer: PeerRecord,
    state: RouteTable
  ): Promise<{ routeCount: number }> {
    const updates: UpdateMessage['updates'] = []

    for (const route of state.local.routes.values()) {
      updates.push({
        action: 'add',
        route,
        nodePath: [this.config.node.name],
        originNode: this.config.node.name,
      })
    }

    for (const innerMap of state.internal.routes.values()) {
      for (const route of innerMap.values()) {
        if (route.isStale === true) continue
        if (route.peer.name === peer.name) continue
        if (route.nodePath.includes(peer.name)) continue

        if (this.routePolicy !== undefined) {
          const allowed = this.routePolicy.canSend(peer, [route])
          if (allowed.length === 0) continue
        }

        updates.push({
          action: 'add',
          route: BusTransforms.toDataChannel(route),
          nodePath: [this.config.node.name, ...route.nodePath],
          originNode: route.originNode,
        })
      }
    }

    if (updates.length === 0) {
      return { routeCount: 0 }
    }

    await this.transport.sendUpdate(peer, { updates })
    return { routeCount: updates.length }
  }
```

- [ ] **Step 2: Rewrite peer_sync WideEvent in `handleBGPNotify()`**

In the `handleBGPNotify()` method, replace the `InternalProtocolConnected` block with try/catch/finally:

```typescript
if (action.action === Actions.InternalProtocolConnected) {
  const peerName = action.data.peerInfo.name
  const peer = connectedPeers.find((p) => p.name === peerName)
  if (peer !== undefined) {
    const event = new WideEvent('orchestrator.peer_sync', logger)
    event.set({
      'catalyst.orchestrator.peer.name': peerName,
      'catalyst.orchestrator.sync.type': 'full',
    })
    try {
      const result = await this.syncRoutesToPeer(peer, state)
      event.set('catalyst.orchestrator.sync.route_count', result.routeCount)
    } catch (error) {
      event.setError(error)
    } finally {
      event.emit()
    }
  }
  return
}
```

- [ ] **Step 3: Rewrite route_propagation WideEvent**

In the same `handleBGPNotify()` method, replace the route propagation block with partial failure tracking:

```typescript
if (plan.routeChanges.length === 0) return

const event = new WideEvent('orchestrator.route_propagation', logger)
event.set({
  'catalyst.orchestrator.peer.connected_count': connectedPeers.length,
  'catalyst.orchestrator.route.change_count': plan.routeChanges.length,
})

try {
  const results = await Promise.allSettled(
    connectedPeers.map(async (peer) => {
      const updates = this.buildUpdatesForPeer(peer, plan, state)
      if (updates.length > 0) {
        await this.transport.sendUpdate(peer, { updates })
      }
    })
  )

  const failedPeers = results
    .map((r, i) => (r.status === 'rejected' ? connectedPeers[i].name : null))
    .filter(Boolean) as string[]
  if (failedPeers.length > 0) {
    event.set({
      'catalyst.orchestrator.peer.failed_count': failedPeers.length,
      'catalyst.orchestrator.peer.failed_peers': failedPeers,
      'catalyst.event.outcome':
        failedPeers.length === connectedPeers.length ? 'failure' : 'partial_failure',
    })
  }
} catch (error) {
  event.setError(error)
} finally {
  event.emit()
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @catalyst/orchestrator test:unit
```

Expected: All tests pass.

- [ ] **Step 5: Commit and submit**

```bash
git add apps/orchestrator/src/v2/bus.ts
gt modify --no-interactive -c -m "refactor(orchestrator): WideEvent cleanup for v2 peer_sync and route_propagation"
gt submit --no-interactive
```

---

### Task 9: Orchestrator v1 — minimal dispatch cleanup

**Files:**

- Modify: `apps/orchestrator/src/v1/orchestrator.ts`

- [ ] **Step 1: Create new branch**

```bash
gt create --no-interactive wide-event-orchestrator-v1-cleanup -m "refactor(orchestrator): WideEvent minimal cleanup for v1 dispatch"
```

- [ ] **Step 2: Rewrite `dispatch()` with try/finally, remove direct intermediate logs**

Replace the `dispatch()` method. Remove the 3 direct intermediate logs (`Dispatching action`, `Route create data`, `Action failed`). Add try/finally. Leave `handleAction()` internal logs and async `handleNotify` as-is:

```typescript
  async dispatch(
    sentAction: Action
  ): Promise<{ success: true } | { success: false; error: string }> {
    const event = new WideEvent('orchestrator.action', this.logger)
    event.set({
      'catalyst.orchestrator.action.type': sentAction.action,
      'catalyst.orchestrator.node.name': this.config.node.name,
    })

    try {
      const prevState = this.state

      const result = await this.handleAction(sentAction, this.state)
      if (result.success) {
        this.state = result.state
        this.lastNotificationPromise = this.handleNotify(sentAction, this.state, prevState).catch(
          (e) => {
            this.logger.error('Error in handleNotify for {action}: {error}', {
              'event.name': 'orchestrator.notify.failed',
              action: sentAction.action,
              error: e,
            })
          }
        )
        return { success: true }
      } else {
        event.setError(result.error)
        return result
      }
    } catch (error) {
      event.setError(error)
      throw error
    } finally {
      event.emit()
    }
  }
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @catalyst/orchestrator test:unit
```

Expected: All tests pass.

- [ ] **Step 4: Commit and submit**

```bash
git add apps/orchestrator/src/v1/orchestrator.ts
gt modify --no-interactive -c -m "refactor(orchestrator): WideEvent minimal cleanup for v1 dispatch"
gt submit --no-interactive
```

---

## Chunk 4: Dashboard Links Config File

### Task 10: Create config file and update loaders

**Files:**

- Create: `docker-compose/dashboard-links.json`
- Modify: `packages/config/src/index.ts`
- Modify: `apps/web-ui/src/server.ts`
- Modify: `docker-compose/docker.compose.yaml`
- Modify: `docker-compose/two-node.compose.yaml`

- [ ] **Step 1: Create new branch**

```bash
gt create --no-interactive dashboard-links-config-file -m "refactor(config): move CATALYST_DASHBOARD_LINKS to config file"
```

- [ ] **Step 2: Create `docker-compose/dashboard-links.json`**

```json
{
  "metrics": "http://localhost:3050/d/catalyst-services?var-service={service}",
  "traces": "http://localhost:3050/explore?schemaVersion=1&panes=%7B%22a%22%3A%7B%22datasource%22%3A%22jaeger%22%2C%22queries%22%3A%5B%7B%22refId%22%3A%22A%22%2C%22queryType%22%3A%22search%22%2C%22service%22%3A%22{service}%22%7D%5D%7D%7D",
  "logs": "http://localhost:3050/explore?schemaVersion=1&panes=%7B%22a%22%3A%7B%22datasource%22%3A%22loki%22%2C%22queries%22%3A%5B%7B%22refId%22%3A%22A%22%2C%22expr%22%3A%22%7Bservice_name%3D%5C%22{service}%5C%22%7D%22%7D%5D%7D%7D"
}
```

- [ ] **Step 3: Add `loadDashboardLinks()` to config package**

In `packages/config/src/index.ts`:

1. Add `import { readFileSync } from 'node:fs'` as the first import, before the existing `import { z } from 'zod'`.

2. Add a new exported function after the `DashboardConfigSchema` definition. This replaces the inline parsing in `loadDefaultConfig()`:

```typescript
/**
 * Load dashboard links from file or env var.
 *
 * Precedence:
 * 1. CATALYST_DASHBOARD_LINKS_FILE → read file, throw on missing/invalid
 * 2. CATALYST_DASHBOARD_LINKS → parse inline JSON, throw on invalid
 * 3. Neither set → undefined
 */
export function loadDashboardLinks(): DashboardConfig['links'] | undefined {
  const filePath = process.env.CATALYST_DASHBOARD_LINKS_FILE
  if (filePath) {
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf-8')
    } catch (err) {
      throw new Error(
        `CATALYST_DASHBOARD_LINKS_FILE: cannot read ${filePath}: ${(err as Error).message}`
      )
    }
    const parsed = JSON.parse(raw) as unknown
    return DashboardConfigSchema.shape.links.parse(parsed)
  }

  const envVar = process.env.CATALYST_DASHBOARD_LINKS
  if (envVar) {
    const parsed = JSON.parse(envVar) as unknown
    return DashboardConfigSchema.shape.links.parse(parsed)
  }

  return undefined
}
```

Then update `loadDefaultConfig()` to use it — replace the dashboard links section:

```typescript
// OLD:
const dashboardLinks = process.env.CATALYST_DASHBOARD_LINKS
let dashboard: { links: Record<string, string> } | undefined
if (dashboardLinks) {
  try {
    dashboard = { links: JSON.parse(dashboardLinks) as Record<string, string> }
  } catch (err) {
    throw new Error(
      `CATALYST_DASHBOARD_LINKS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

// NEW:
const links = loadDashboardLinks()
const dashboard = links ? { links } : undefined
```

Add `loadDashboardLinks` to the package exports if not already re-exported.

- [ ] **Step 4: Update web-ui to use the config package loader**

In `apps/web-ui/src/server.ts`, replace the manual JSON parsing:

```typescript
// OLD:
const dashboardLinksRaw = process.env.CATALYST_DASHBOARD_LINKS
let dashboardLinks: Record<string, string> | undefined
if (dashboardLinksRaw) {
  try {
    dashboardLinks = JSON.parse(dashboardLinksRaw) as Record<string, string>
  } catch {
    console.warn('Failed to parse CATALYST_DASHBOARD_LINKS, ignoring')
  }
}

// NEW:
import { loadDashboardLinks } from '@catalyst/config'

const dashboardLinks = loadDashboardLinks()
```

- [ ] **Step 5: Update `docker-compose/docker.compose.yaml`**

For each service that has `CATALYST_DASHBOARD_LINKS`:

1. Remove the inline `CATALYST_DASHBOARD_LINKS=...` env var
2. Add `CATALYST_DASHBOARD_LINKS_FILE=/app/config/dashboard-links.json`
3. Add a volume mount: `./dashboard-links.json:/app/config/dashboard-links.json:ro`

Example for the orchestrator service:

```yaml
volumes:
  - ./dashboard-links.json:/app/config/dashboard-links.json:ro
environment:
  - CATALYST_DASHBOARD_LINKS_FILE=/app/config/dashboard-links.json
```

Apply the same pattern to the web-ui service. Remove the duplicated inline JSON from both.

- [ ] **Step 6: Update `docker-compose/two-node.compose.yaml`**

Same changes as Step 5 for all 3 services that have `CATALYST_DASHBOARD_LINKS` (node-a orchestrator, node-b orchestrator, web-ui).

- [ ] **Step 7: Run tests**

```bash
pnpm --filter @catalyst/config test:unit
pnpm --filter @catalyst/web-ui test:unit
```

Expected: All tests pass.

- [ ] **Step 8: Commit and submit**

```bash
git add docker-compose/dashboard-links.json packages/config/src/index.ts apps/web-ui/src/server.ts docker-compose/docker.compose.yaml docker-compose/two-node.compose.yaml
gt modify --no-interactive -c -m "refactor(config): move dashboard links to config file"
gt submit --no-interactive
```

---

## Summary

| Task | PR  | What it does                       | Commit message                                                       |
| ---- | --- | ---------------------------------- | -------------------------------------------------------------------- |
| 1-3  | 1   | views.ts → plain functions + zod   | `refactor(routing): replace view classes with plain functions + zod` |
| 4    | 2   | Gateway WideEvent Option A         | `refactor(gateway): WideEvent Option A cleanup`                      |
| 5    | 3   | Envoy WideEvent Option A           | `refactor(envoy): WideEvent Option A cleanup`                        |
| 6-8  | 4   | Orchestrator v2 WideEvent Option A | `refactor(orchestrator): WideEvent Option A cleanup for v2`          |
| 9    | 5   | Orchestrator v1 WideEvent minimal  | `refactor(orchestrator): WideEvent minimal cleanup for v1 dispatch`  |
| 10   | 6   | Dashboard links → config file      | `refactor(config): move dashboard links to config file`              |

After all PRs: run manual verification plan from the spec (Section "Manual Verification Plan").
