# Per-Adapter Status Page Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add health status visibility for all adapters across the Catalyst mesh by having each node probe its local adapters and propagate health data via iBGP.

**Architecture:** The v2 orchestrator gains an `AdapterHealthChecker` that periodically hits `GET /health` on local adapters. Health metadata (`healthStatus`, `responseTimeMs`, `lastChecked`) is added to `DataChannelDefinition` and flows through the existing iBGP route propagation. The web-ui frontend's Adapters tab is updated from a card list to a Figma-style table with status badges.

**Tech Stack:** TypeScript, Zod, Vitest, React, Hono, capnweb RPC

**Spec:** `docs/superpowers/specs/2026-03-16-per-adapter-status-design.md`

---

## File Structure

| File                                                            | Action    | Responsibility                                                                         |
| --------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------- |
| `packages/routing/src/v2/datachannel.ts`                        | Modify    | Add optional health fields to `DataChannelDefinitionSchema`                            |
| `packages/routing/src/v2/views.ts`                              | Modify    | Include health fields in `toDataChannel()` and ensure `toPublic()` passes them through |
| `packages/routing/src/v2/state.ts`                              | No change | `InternalRoute = DataChannelDefinition & {...}` inherits health fields automatically   |
| `packages/routing/src/v2/internal/actions.ts`                   | No change | `UpdateMessageSchema` uses `DataChannelDefinitionSchema`, inherits new fields          |
| `packages/config/src/index.ts`                                  | Modify    | Add `adapterHealth` config block to `OrchestratorConfigSchema`                         |
| `apps/orchestrator/src/v2/adapter-health.ts`                    | Create    | `AdapterHealthChecker` class                                                           |
| `apps/orchestrator/src/v2/catalyst-service.ts`                  | Modify    | Wire `AdapterHealthChecker` into service lifecycle                                     |
| `apps/orchestrator/tests/v2/adapter-health.test.ts`             | Create    | Unit tests for health checker                                                          |
| `apps/orchestrator/tests/v2/adapter-health-propagation.test.ts` | Create    | Integration tests for health data flowing through iBGP                                 |
| `apps/web-ui/frontend/src/hooks/useRouterState.ts`              | Modify    | Add health fields + `originNode` to frontend types                                     |
| `apps/web-ui/frontend/src/components/AdaptersTab.tsx`           | Modify    | Replace card list with table layout + status badges                                    |

---

## Chunk 1: Schema & Propagation

### Task 1: Add health fields to DataChannelDefinitionSchema

**Files:**

- Modify: `packages/routing/src/v2/datachannel.ts:12-24`

- [ ] **Step 1: Add optional health fields to the Zod schema**

In `packages/routing/src/v2/datachannel.ts`, add three optional fields to `DataChannelDefinitionSchema`:

```typescript
export const DataChannelDefinitionSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i),
  endpoint: z.url().optional(),
  protocol: DataChannelProtocolEnum,
  region: z.string().optional(),
  tags: z.array(z.string()).optional(),
  envoyPort: z.number().int().optional(),
  healthStatus: z.enum(['up', 'down', 'unknown']).optional(),
  responseTimeMs: z.number().nullable().optional(),
  lastChecked: z.string().optional(),
})
```

- [ ] **Step 2: Run existing routing tests to confirm no regressions**

Run: `cd packages/routing && bun test`
Expected: All existing tests pass (health fields are optional, so existing data is still valid).

- [ ] **Step 3: Commit**

```bash
gt commit --no-interactive create -m "feat(routing): add optional health fields to DataChannelDefinitionSchema"
```

### Task 2: Include health fields in InternalRouteView.toDataChannel()

**Files:**

- Modify: `packages/routing/src/v2/views.ts:57-67`

- [ ] **Step 1: Update toDataChannel() to include health fields**

In `packages/routing/src/v2/views.ts`, update `InternalRouteView.toDataChannel()`:

```typescript
toDataChannel(): DataChannelDefinition {
  return {
    name: this.data.name,
    protocol: this.data.protocol,
    endpoint: this.data.endpoint,
    region: this.data.region,
    tags: this.data.tags,
    envoyPort: this.data.envoyPort,
    healthStatus: this.data.healthStatus,
    responseTimeMs: this.data.responseTimeMs,
    lastChecked: this.data.lastChecked,
  }
}
```

- [ ] **Step 2: Run routing tests**

Run: `cd packages/routing && bun test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
gt commit --no-interactive create -m "feat(routing): include health fields in toDataChannel()"
```

### Task 3: Test health data propagation through iBGP

**Files:**

- Create: `apps/orchestrator/tests/v2/adapter-health-propagation.test.ts`

- [ ] **Step 1: Write propagation tests**

```typescript
import { describe, it, expect } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

const configA: OrchestratorConfig = {
  node: {
    name: 'node-a',
    endpoint: 'ws://node-a:4000',
    domains: ['test.local'],
  },
}

const peerB: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['test.local'],
}

function makeBus(config: OrchestratorConfig) {
  const transport = new MockPeerTransport()
  return { bus: new OrchestratorBus({ config, transport }), transport }
}

async function connectPeer(bus: OrchestratorBus, peer: PeerInfo) {
  await bus.dispatch({ action: Actions.LocalPeerCreate, data: peer })
  await bus.dispatch({ action: Actions.InternalProtocolConnected, data: { peerInfo: peer } })
}

describe('adapter health propagation', () => {
  it('local route with health fields appears in state snapshot', async () => {
    const { bus } = makeBus(configA)
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: {
        name: 'books',
        protocol: 'http:graphql' as const,
        endpoint: 'http://books:4001/graphql',
        healthStatus: 'up',
        responseTimeMs: 12,
        lastChecked: '2026-03-16T00:00:00Z',
      },
    })

    const state = bus.getStateSnapshot()
    const route = state.local.routes[0]
    expect(route.healthStatus).toBe('up')
    expect(route.responseTimeMs).toBe(12)
    expect(route.lastChecked).toBe('2026-03-16T00:00:00Z')
  })

  it('health fields propagate to peer via iBGP update', async () => {
    const { bus, transport } = makeBus(configA)
    await connectPeer(bus, peerB)

    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: {
        name: 'books',
        protocol: 'http:graphql' as const,
        endpoint: 'http://books:4001/graphql',
        healthStatus: 'up',
        responseTimeMs: 12,
        lastChecked: '2026-03-16T00:00:00Z',
      },
    })

    const sentUpdates = transport.getLastUpdate()
    expect(sentUpdates).toBeDefined()
    const routeUpdate = sentUpdates!.updates[0]
    expect(routeUpdate.route.healthStatus).toBe('up')
    expect(routeUpdate.route.responseTimeMs).toBe(12)
  })

  it('route without health fields defaults to undefined (backward compat)', async () => {
    const { bus } = makeBus(configA)
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: {
        name: 'legacy',
        protocol: 'http' as const,
        endpoint: 'http://legacy:8080',
      },
    })

    const state = bus.getStateSnapshot()
    const route = state.local.routes[0]
    expect(route.healthStatus).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run propagation tests**

Run: `cd apps/orchestrator && bun test tests/v2/adapter-health-propagation.test.ts`
Expected: All 3 tests pass. If the `MockPeerTransport` doesn't have `getLastUpdate()`, check its API and adjust — the goal is to verify the update message sent to the peer contains health fields.

- [ ] **Step 3: Commit**

```bash
gt commit --no-interactive create -m "test(orchestrator): add adapter health propagation tests"
```

---

## Chunk 2: Config & Health Checker

### Task 4: Add adapterHealth config block

**Files:**

- Modify: `packages/config/src/index.ts`

- [ ] **Step 1: Add adapterHealth to OrchestratorConfigSchema**

In `packages/config/src/index.ts`, add `adapterHealth` to `OrchestratorConfigSchema`:

```typescript
export const OrchestratorConfigSchema = z.object({
  gqlGatewayConfig: z
    .object({
      endpoint: z.string(),
    })
    .optional(),
  auth: z
    .object({
      endpoint: z.string(),
      systemToken: z.string(),
    })
    .optional(),
  envoyConfig: z.object({
    endpoint: z.string(),
    envoyAddress: z.string().optional(),
    portRange: z.array(PortEntrySchema).min(1),
  }),
  adapterHealth: z
    .object({
      enabled: z.boolean().default(true),
      intervalMs: z.number().int().min(0).default(30_000),
      timeoutMs: z.number().int().min(100).default(3_000),
    })
    .optional(),
})
```

- [ ] **Step 2: Add env var loading in loadDefaultConfig()**

In the `loadDefaultConfig()` function, add env var parsing for adapter health config. Find the section where orchestrator config is assembled and add:

```typescript
const adapterHealthEnabled = process.env.CATALYST_ADAPTER_HEALTH_ENABLED
const adapterHealthInterval = process.env.CATALYST_ADAPTER_HEALTH_INTERVAL_MS
const adapterHealthTimeout = process.env.CATALYST_ADAPTER_HEALTH_TIMEOUT_MS

// In the orchestrator config object:
adapterHealth: {
  enabled: adapterHealthEnabled !== undefined ? adapterHealthEnabled !== 'false' : true,
  intervalMs: adapterHealthInterval ? parseInt(adapterHealthInterval, 10) : 30_000,
  timeoutMs: adapterHealthTimeout ? parseInt(adapterHealthTimeout, 10) : 3_000,
},
```

- [ ] **Step 3: Run config tests if they exist**

Run: `cd packages/config && bun test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
gt commit --no-interactive create -m "feat(config): add adapterHealth config block with env var support"
```

### Task 5: Implement AdapterHealthChecker

**Files:**

- Create: `apps/orchestrator/src/v2/adapter-health.ts`
- Create: `apps/orchestrator/tests/v2/adapter-health.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/orchestrator/tests/v2/adapter-health.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AdapterHealthChecker } from '../../src/v2/adapter-health.js'
import type { DataChannelDefinition } from '@catalyst/routing/v2'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeRoute(overrides: Partial<DataChannelDefinition> = {}): DataChannelDefinition {
  return {
    name: 'test-adapter',
    protocol: 'http:graphql',
    endpoint: 'http://test:4001/graphql',
    ...overrides,
  }
}

describe('AdapterHealthChecker', () => {
  let checker: AdapterHealthChecker

  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockReset()
    checker = new AdapterHealthChecker({ intervalMs: 30_000, timeoutMs: 3_000 })
  })

  afterEach(() => {
    checker.stop()
    vi.useRealTimers()
  })

  it('marks adapter as up when /health returns 200', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{"status":"Health"}', { status: 200 }))

    const routes = [makeRoute()]
    const results = await checker.checkAll(routes)

    expect(results.get('test-adapter')).toMatchObject({
      healthStatus: 'up',
    })
    expect(results.get('test-adapter')!.responseTimeMs).toBeGreaterThanOrEqual(0)
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test:4001/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('marks adapter as unknown when /health returns 404', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))

    const routes = [makeRoute()]
    const results = await checker.checkAll(routes)

    expect(results.get('test-adapter')).toMatchObject({
      healthStatus: 'unknown',
      responseTimeMs: null,
    })
  })

  it('does not re-check adapter after 404 (no health endpoint)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))

    const routes = [makeRoute()]
    await checker.checkAll(routes)
    mockFetch.mockClear()

    await checker.checkAll(routes)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('marks adapter as down when previously up and now fails', async () => {
    // First check: up
    mockFetch.mockResolvedValueOnce(new Response('{"status":"Health"}', { status: 200 }))
    const routes = [makeRoute()]
    await checker.checkAll(routes)

    // Second check: timeout/error
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'))
    const results = await checker.checkAll(routes)

    expect(results.get('test-adapter')).toMatchObject({
      healthStatus: 'down',
      responseTimeMs: null,
    })
  })

  it('marks non-HTTP protocol as unknown without making request', async () => {
    const routes = [makeRoute({ protocol: 'tcp', endpoint: 'tcp://service:9000' })]
    const results = await checker.checkAll(routes)

    expect(results.get('test-adapter')).toMatchObject({
      healthStatus: 'unknown',
      responseTimeMs: null,
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('constructs health URL by replacing path with /health', async () => {
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))

    const routes = [makeRoute({ endpoint: 'http://books:4001/graphql' })]
    await checker.checkAll(routes)

    expect(mockFetch).toHaveBeenCalledWith('http://books:4001/health', expect.any(Object))
  })

  it('marks adapter as unknown when endpoint is missing', async () => {
    const routes = [makeRoute({ endpoint: undefined })]
    const results = await checker.checkAll(routes)

    expect(results.get('test-adapter')).toMatchObject({
      healthStatus: 'unknown',
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('clears health entry when route is removed', async () => {
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))
    const routes = [makeRoute()]
    await checker.checkAll(routes)
    expect(checker.getHealth('test-adapter')).toBeDefined()

    // Check with empty routes — should clear
    await checker.checkAll([])
    expect(checker.getHealth('test-adapter')).toBeUndefined()
  })

  it('checks all adapters in parallel', async () => {
    let resolveA: () => void
    let resolveB: () => void
    const promiseA = new Promise<Response>((r) => {
      resolveA = () => r(new Response('OK', { status: 200 }))
    })
    const promiseB = new Promise<Response>((r) => {
      resolveB = () => r(new Response('OK', { status: 200 }))
    })

    mockFetch.mockReturnValueOnce(promiseA).mockReturnValueOnce(promiseB)

    const routes = [
      makeRoute({ name: 'a', endpoint: 'http://a:4001/graphql' }),
      makeRoute({ name: 'b', endpoint: 'http://b:4002/graphql' }),
    ]

    const promise = checker.checkAll(routes)

    // Both fetches should have been called before either resolves
    expect(mockFetch).toHaveBeenCalledTimes(2)

    resolveA!()
    resolveB!()
    await promise
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/orchestrator && bun test tests/v2/adapter-health.test.ts`
Expected: FAIL — `AdapterHealthChecker` does not exist yet.

- [ ] **Step 3: Implement AdapterHealthChecker**

Create `apps/orchestrator/src/v2/adapter-health.ts`:

```typescript
import type { DataChannelDefinition } from '@catalyst/routing/v2'

export interface AdapterHealth {
  healthStatus: 'up' | 'down' | 'unknown'
  responseTimeMs: number | null
  lastChecked: string
}

interface AdapterHealthCheckerOptions {
  intervalMs: number
  timeoutMs: number
}

export class AdapterHealthChecker {
  private readonly options: AdapterHealthCheckerOptions
  private readonly healthMap = new Map<string, AdapterHealth>()
  private readonly noHealthEndpoint = new Set<string>()
  private interval: ReturnType<typeof setInterval> | undefined

  constructor(options: AdapterHealthCheckerOptions) {
    this.options = options
  }

  /** Start periodic health checks against the provided route source. */
  start(getRoutes: () => DataChannelDefinition[]): void {
    if (this.options.intervalMs <= 0) return
    this.interval = setInterval(() => {
      this.checkAll(getRoutes()).catch(() => {})
    }, this.options.intervalMs)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = undefined
    }
  }

  getHealth(name: string): AdapterHealth | undefined {
    return this.healthMap.get(name)
  }

  /** Apply health data to routes in-place. Returns the same array with health fields set. */
  applyHealth(routes: DataChannelDefinition[]): DataChannelDefinition[] {
    for (const route of routes) {
      const health = this.healthMap.get(route.name)
      if (health) {
        route.healthStatus = health.healthStatus
        route.responseTimeMs = health.responseTimeMs
        route.lastChecked = health.lastChecked
      }
    }
    return routes
  }

  /** Check all routes and return health results. Clears entries for removed routes. */
  async checkAll(routes: DataChannelDefinition[]): Promise<Map<string, AdapterHealth>> {
    const currentNames = new Set(routes.map((r) => r.name))

    // Clear entries for removed routes
    for (const name of this.healthMap.keys()) {
      if (!currentNames.has(name)) {
        this.healthMap.delete(name)
        this.noHealthEndpoint.delete(name)
      }
    }

    const checks = routes.map((route) => this.checkOne(route))
    await Promise.allSettled(checks)

    return this.healthMap
  }

  private async checkOne(route: DataChannelDefinition): Promise<void> {
    const { name } = route

    // Skip if we already know there's no health endpoint
    if (this.noHealthEndpoint.has(name)) {
      return
    }

    // Skip non-HTTP protocols or missing endpoints
    if (!route.endpoint || !this.isHttpProtocol(route)) {
      this.healthMap.set(name, {
        healthStatus: 'unknown',
        responseTimeMs: null,
        lastChecked: new Date().toISOString(),
      })
      return
    }

    const healthUrl = this.buildHealthUrl(route.endpoint)
    if (!healthUrl) {
      this.healthMap.set(name, {
        healthStatus: 'unknown',
        responseTimeMs: null,
        lastChecked: new Date().toISOString(),
      })
      return
    }

    const start = performance.now()
    try {
      const res = await fetch(healthUrl, {
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })

      if (res.status === 404) {
        this.noHealthEndpoint.add(name)
        this.healthMap.set(name, {
          healthStatus: 'unknown',
          responseTimeMs: null,
          lastChecked: new Date().toISOString(),
        })
        return
      }

      if (res.ok) {
        this.healthMap.set(name, {
          healthStatus: 'up',
          responseTimeMs: Math.round(performance.now() - start),
          lastChecked: new Date().toISOString(),
        })
      } else {
        const prev = this.healthMap.get(name)
        this.healthMap.set(name, {
          healthStatus: prev?.healthStatus === 'up' ? 'down' : 'unknown',
          responseTimeMs: null,
          lastChecked: new Date().toISOString(),
        })
      }
    } catch {
      const prev = this.healthMap.get(name)
      this.healthMap.set(name, {
        healthStatus: prev?.healthStatus === 'up' ? 'down' : 'unknown',
        responseTimeMs: null,
        lastChecked: new Date().toISOString(),
      })
    }
  }

  private isHttpProtocol(route: DataChannelDefinition): boolean {
    return route.protocol.startsWith('http')
  }

  private buildHealthUrl(endpoint: string): string | null {
    try {
      const url = new URL(endpoint)
      url.pathname = '/health'
      return url.toString()
    } catch {
      return null
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/orchestrator && bun test tests/v2/adapter-health.test.ts`
Expected: All 8 tests pass.

- [ ] **Step 5: Commit**

```bash
gt commit --no-interactive create -m "feat(orchestrator): add AdapterHealthChecker with periodic health probing"
```

### Task 6: Wire AdapterHealthChecker into orchestrator service

**Files:**

- Modify: `apps/orchestrator/src/v2/catalyst-service.ts:93-175`

- [ ] **Step 1: Import and instantiate AdapterHealthChecker**

In `apps/orchestrator/src/v2/catalyst-service.ts`, add import at top:

```typescript
import { AdapterHealthChecker } from './adapter-health.js'
```

Add field to class:

```typescript
private _healthChecker: AdapterHealthChecker | undefined
```

- [ ] **Step 2: Initialize health checker in onInitialize()**

After `this._v2 = new OrchestratorServiceV2(...)` and before `this._v2.start()`, add:

```typescript
const adapterHealthConfig = this.config.orchestrator?.adapterHealth
if (adapterHealthConfig?.enabled !== false) {
  this._healthChecker = new AdapterHealthChecker({
    intervalMs: adapterHealthConfig?.intervalMs ?? 30_000,
    timeoutMs: adapterHealthConfig?.timeoutMs ?? 3_000,
  })
  this._healthChecker.start(() => this._v2.bus.state.local.routes)
}
```

- [ ] **Step 3: Update /api/state to include health data**

Modify the `/api/state` handler to apply health data to local routes before returning:

```typescript
this.handler.get('/api/state', (c) => {
  const snapshot = bus.getStateSnapshot()
  if (this._healthChecker) {
    this._healthChecker.applyHealth(snapshot.local.routes)
  }
  return c.json(new RouteTableView(snapshot).toPublic())
})
```

- [ ] **Step 4: Stop health checker in onShutdown()**

In `onShutdown()`, add:

```typescript
this._healthChecker?.stop()
```

- [ ] **Step 5: Run existing orchestrator tests to verify no regressions**

Run: `cd apps/orchestrator && bun test`
Expected: All existing tests pass.

- [ ] **Step 6: Commit**

```bash
gt commit --no-interactive create -m "feat(orchestrator): wire AdapterHealthChecker into service lifecycle and /api/state"
```

---

## Chunk 3: Frontend

### Task 7: Update frontend types for health data

**Files:**

- Modify: `apps/web-ui/frontend/src/hooks/useRouterState.ts:3-31`

- [ ] **Step 1: Add health fields to DataChannelDefinition interface**

```typescript
export interface DataChannelDefinition {
  name: string
  endpoint?: string
  protocol: string
  region?: string
  tags?: string[]
  envoyPort?: number
  healthStatus?: 'up' | 'down' | 'unknown'
  responseTimeMs?: number | null
  lastChecked?: string
}
```

- [ ] **Step 2: Add originNode to InternalRoute interface**

```typescript
export interface InternalRoute extends DataChannelDefinition {
  peer: { name: string; endpoint?: string; domains: string[] }
  nodePath: string[]
  originNode?: string
}
```

- [ ] **Step 3: Commit**

```bash
gt commit --no-interactive create -m "feat(web-ui): add health fields and originNode to frontend types"
```

### Task 8: Replace AdaptersTab with table layout

**Files:**

- Modify: `apps/web-ui/frontend/src/components/AdaptersTab.tsx`

- [ ] **Step 1: Rewrite AdaptersTab as a table with all columns**

Replace the full content of `AdaptersTab.tsx`:

```tsx
import { useRouterState } from '../hooks/useRouterState'
import type { DataChannelDefinition, InternalRoute } from '../hooks/useRouterState'

type AdapterRow = DataChannelDefinition & { origin: string }

function toRows(state: {
  routes: { local: DataChannelDefinition[]; internal: InternalRoute[] }
}): AdapterRow[] {
  const rows: AdapterRow[] = []
  for (const route of state.routes.local) {
    rows.push({ ...route, origin: 'local' })
  }
  for (const route of state.routes.internal) {
    rows.push({ ...route, origin: route.originNode ?? route.peer.name })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

function StatusBadge({ status }: { status?: 'up' | 'down' | 'unknown' }) {
  const s = status ?? 'unknown'
  const styles: Record<string, { bg: string; color: string; label: string }> = {
    up: { bg: 'var(--status-up-bg)', color: 'var(--status-up)', label: 'Up' },
    down: { bg: 'var(--status-down-bg)', color: 'var(--status-down)', label: 'Down' },
    unknown: { bg: 'var(--bg-elevated)', color: 'var(--status-unknown)', label: 'Unknown' },
  }
  const { bg, color, label } = styles[s]
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: bg,
        color,
        padding: '2px 10px',
        borderRadius: 12,
        fontFamily: 'var(--font-mono)',
        fontSize: '0.75rem',
        fontWeight: 500,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
        }}
      />
      {label}
    </span>
  )
}

function formatResponseTime(ms?: number | null): string {
  if (ms == null) return '—'
  return `${ms}ms`
}

function oldestLastChecked(rows: AdapterRow[]): string | null {
  let oldest: string | null = null
  for (const row of rows) {
    if (row.lastChecked) {
      if (!oldest || row.lastChecked < oldest) oldest = row.lastChecked
    }
  }
  return oldest
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 1000) return 'just now'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ago`
}

export function AdaptersTab() {
  const { state, loading } = useRouterState()

  if (loading || !state) {
    return (
      <div style={{ padding: '3rem 0', textAlign: 'center' }}>
        <div
          style={{
            width: 28,
            height: 28,
            border: '2px solid var(--border-default)',
            borderTopColor: 'var(--primary)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            margin: '0 auto 1rem',
          }}
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <p
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85rem',
            color: 'var(--text-tertiary)',
          }}
        >
          loading adapters...
        </p>
      </div>
    )
  }

  const rows = toRows(state)

  if (rows.length === 0) {
    return (
      <div
        style={{
          border: '1px dashed var(--border-default)',
          borderRadius: 'var(--radius-lg)',
          padding: '4rem 2rem',
          textAlign: 'center',
        }}
      >
        <h3
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 600,
            fontSize: '1.05rem',
            color: 'var(--text-secondary)',
            marginBottom: '0.35rem',
          }}
        >
          No Adapters
        </h3>
        <p
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85rem',
            color: 'var(--text-tertiary)',
          }}
        >
          No data channels registered on this node or peers
        </p>
      </div>
    )
  }

  const oldest = oldestLastChecked(rows)
  const nodeCount = new Set(rows.map((r) => r.origin)).size

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.82rem',
        }}
      >
        <thead>
          <tr
            style={{
              background: 'var(--primary-light)',
              borderBottom: '1px solid var(--border-default)',
            }}
          >
            <th style={thStyle}>Data channel</th>
            <th style={thStyle}>Protocol</th>
            <th style={thStyle}>Endpoint</th>
            <th style={thStyle}>Origin</th>
            <th style={thStyle}>Status</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>Response</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={`${row.origin}-${row.name}`}
              style={{
                borderBottom: '1px solid var(--border-subtle)',
                animation: 'fadeInUp 0.3s ease both',
                animationDelay: `${i * 0.03}s`,
              }}
            >
              <td style={{ ...tdStyle, fontWeight: 500, color: 'var(--text-primary)' }}>
                {row.name}
              </td>
              <td style={{ ...tdStyle, color: 'var(--text-tertiary)' }}>{row.protocol}</td>
              <td
                style={{
                  ...tdStyle,
                  color: 'var(--text-tertiary)',
                  fontSize: '0.72rem',
                  maxWidth: 240,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {row.endpoint ?? '—'}
              </td>
              <td style={{ ...tdStyle, color: 'var(--link)', fontSize: '0.78rem' }}>
                {row.origin}
              </td>
              <td style={tdStyle}>
                <StatusBadge status={row.healthStatus} />
              </td>
              <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-tertiary)' }}>
                {formatResponseTime(row.responseTimeMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div
        style={{
          padding: '0.6rem 1rem',
          display: 'flex',
          justifyContent: 'space-between',
          borderTop: '1px solid var(--border-subtle)',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.75rem',
          color: 'var(--text-tertiary)',
        }}
      >
        <span>
          {rows.length} adapter{rows.length !== 1 ? 's' : ''} across {nodeCount} node
          {nodeCount !== 1 ? 's' : ''}
        </span>
        {oldest && <span>Last checked: {relativeTime(oldest)}</span>}
      </div>
    </div>
  )
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.6rem 1rem',
  color: 'var(--primary-dark)',
  fontWeight: 600,
  fontSize: '0.72rem',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
}

const tdStyle: React.CSSProperties = {
  padding: '0.7rem 1rem',
}
```

- [ ] **Step 2: Verify the frontend builds**

Run: `cd apps/web-ui && bun run build` (or whatever the build command is — check `package.json`)
Expected: Build succeeds with no type errors.

- [ ] **Step 3: Commit**

```bash
gt commit --no-interactive create -m "feat(web-ui): replace AdaptersTab card list with table layout and health badges"
```

### Task 9: Manual verification

- [ ] **Step 1: Start a local dev cluster**

Start the orchestrator, web-ui, and a simple HTTP adapter that has `/health`. Check the project's `docker-compose.yaml` or dev scripts for how to run locally.

- [ ] **Step 2: Verify "Up" status**

Open the status page in a browser. Navigate to the Adapters tab. Confirm the adapter shows a green "Up" badge with a response time.

- [ ] **Step 3: Verify "Down" status**

Stop the adapter process. Wait 30 seconds for the next health check cycle. Refresh the status page. Confirm the adapter shows a red "Down" badge.

- [ ] **Step 4: Verify "Unknown" status**

Register a TCP adapter (no `/health` endpoint) via the CLI. Confirm it shows a yellow "Unknown" badge.

- [ ] **Step 5: Verify propagation**

If possible, start a second node peered with the first. Confirm the adapter's health status appears on the second node's status page with the correct origin node name.

- [ ] **Step 6: Verify recovery**

Restart the stopped adapter. Wait for the next health check cycle. Confirm status returns to "Up".

- [ ] **Step 7: Submit PR**

```bash
gt submit --no-interactive
```
