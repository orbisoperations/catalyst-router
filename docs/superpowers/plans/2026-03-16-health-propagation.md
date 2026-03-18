# Health Status iBGP Propagation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Propagate adapter health status changes from origin nodes to peers via iBGP, so every node sees health data for every adapter in the mesh.

**Architecture:** Add a `LocalRouteHealthUpdate` action to the RIB that updates health fields on an existing local route and triggers iBGP propagation via `routeChanges`. The `AdapterHealthChecker` dispatches this action only when `healthStatus` actually changes (not every cycle), preventing iBGP churn. `lastChecked`/`responseTimeMs` still update locally every cycle via query-time patching.

**Tech Stack:** TypeScript, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-03-16-health-propagation-design.md`

---

## File Structure

| File                                                            | Action | Responsibility                              |
| --------------------------------------------------------------- | ------ | ------------------------------------------- |
| `packages/routing/src/v2/action-types.ts`                       | Modify | Add `LocalRouteHealthUpdate` constant       |
| `packages/routing/src/v2/local/actions.ts`                      | Modify | Add `localRouteHealthUpdateMessageSchema`   |
| `packages/routing/src/v2/schema.ts`                             | Modify | Add to `ActionSchema` discriminated union   |
| `packages/routing/src/v2/rib/rib.ts`                            | Modify | Add `planLocalRouteHealthUpdate()` handler  |
| `apps/orchestrator/src/v2/adapter-health.ts`                    | Modify | Add `dispatchFn`, dispatch on status change |
| `apps/orchestrator/src/v2/catalyst-service.ts`                  | Modify | Pass `dispatchFn` to health checker         |
| `packages/routing/tests/v2/rib-health-update.test.ts`           | Create | RIB unit tests                              |
| `apps/orchestrator/tests/v2/adapter-health.test.ts`             | Modify | Add dispatch tests                          |
| `apps/orchestrator/tests/v2/adapter-health-propagation.test.ts` | Modify | Add end-to-end propagation test             |

---

## Task 1: Add LocalRouteHealthUpdate action type and schema

**Files:**

- Modify: `packages/routing/src/v2/action-types.ts:12-13`
- Modify: `packages/routing/src/v2/local/actions.ts`
- Modify: `packages/routing/src/v2/schema.ts:22-34`

- [ ] **Step 1: Add action constant**

In `packages/routing/src/v2/action-types.ts`, add after `LocalRouteDelete`:

```typescript
  // Local route management
  LocalRouteCreate: 'local:route:create',
  LocalRouteDelete: 'local:route:delete',
  LocalRouteHealthUpdate: 'local:route:health-update',
```

- [ ] **Step 2: Add message schema**

In `packages/routing/src/v2/local/actions.ts`, add at the end:

```typescript
export const localRouteHealthUpdateAction = z.literal(Actions.LocalRouteHealthUpdate)

export const localRouteHealthUpdateMessageSchema = z.object({
  action: z.literal(Actions.LocalRouteHealthUpdate),
  data: z.object({
    name: z.string(),
    healthStatus: z.enum(['up', 'down', 'unknown']),
    responseTimeMs: z.number().nullable(),
    lastChecked: z.string(),
  }),
})
```

- [ ] **Step 3: Add to ActionSchema**

In `packages/routing/src/v2/schema.ts`, add import:

```typescript
import {
  localPeerCreateMessageSchema,
  localPeerUpdateMessageSchema,
  localPeerDeleteMessageSchema,
  localRouteCreateMessageSchema,
  localRouteDeleteMessageSchema,
  localRouteHealthUpdateMessageSchema,
} from './local/actions.js'
```

And add to the discriminated union array after `localRouteDeleteMessageSchema`:

```typescript
  localRouteHealthUpdateMessageSchema,
```

- [ ] **Step 4: Run routing tests**

Run: `cd packages/routing && bun test`
Expected: All existing tests pass (new schema is additive).

- [ ] **Step 5: Commit**

```bash
gt commit --no-interactive create -m "feat(routing): add LocalRouteHealthUpdate action type and schema"
```

---

## Task 2: Add RIB planner handler with tests

**Files:**

- Modify: `packages/routing/src/v2/rib/rib.ts:96-123`
- Create: `packages/routing/tests/v2/rib-health-update.test.ts`

- [ ] **Step 1: Write the tests**

Create `packages/routing/tests/v2/rib-health-update.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { RoutingInformationBase } from '../../src/v2/rib/rib.js'
import { Actions } from '../../src/v2/action-types.js'
import type { RouteTable } from '../../src/v2/state.js'

function makeRib(state?: RouteTable) {
  return new RoutingInformationBase({
    nodeId: 'node-a',
    initialState: state,
  })
}

function stateWithRoute(overrides: Record<string, unknown> = {}): RouteTable {
  return {
    local: {
      routes: [
        {
          name: 'books-api',
          protocol: 'http:graphql' as const,
          endpoint: 'http://books:4001/graphql',
          ...overrides,
        },
      ],
    },
    internal: { peers: [], routes: [] },
  }
}

describe('planLocalRouteHealthUpdate', () => {
  it('updates health fields on existing local route', () => {
    const rib = makeRib(stateWithRoute())
    const plan = rib.plan(
      {
        action: Actions.LocalRouteHealthUpdate,
        data: {
          name: 'books-api',
          healthStatus: 'up' as const,
          responseTimeMs: 12,
          lastChecked: '2026-03-17T00:00:00Z',
        },
      },
      rib.state
    )

    expect(rib.stateChanged(plan)).toBe(true)
    expect(plan.newState.local.routes[0].healthStatus).toBe('up')
    expect(plan.newState.local.routes[0].responseTimeMs).toBe(12)
    expect(plan.newState.local.routes[0].lastChecked).toBe('2026-03-17T00:00:00Z')
    expect(plan.routeChanges).toHaveLength(1)
    expect(plan.routeChanges[0].type).toBe('updated')
  })

  it('returns noChange for non-existent route', () => {
    const rib = makeRib(stateWithRoute())
    const plan = rib.plan(
      {
        action: Actions.LocalRouteHealthUpdate,
        data: {
          name: 'no-such-route',
          healthStatus: 'up' as const,
          responseTimeMs: 5,
          lastChecked: '2026-03-17T00:00:00Z',
        },
      },
      rib.state
    )

    expect(rib.stateChanged(plan)).toBe(false)
  })

  it('returns noChange when health fields are identical', () => {
    const rib = makeRib(
      stateWithRoute({
        healthStatus: 'up',
        responseTimeMs: 12,
        lastChecked: '2026-03-17T00:00:00Z',
      })
    )
    const plan = rib.plan(
      {
        action: Actions.LocalRouteHealthUpdate,
        data: {
          name: 'books-api',
          healthStatus: 'up' as const,
          responseTimeMs: 12,
          lastChecked: '2026-03-17T00:00:00Z',
        },
      },
      rib.state
    )

    expect(rib.stateChanged(plan)).toBe(false)
  })

  it('preserves other route fields when updating health', () => {
    const rib = makeRib(stateWithRoute({ region: 'us-east', tags: ['prod'] }))
    const plan = rib.plan(
      {
        action: Actions.LocalRouteHealthUpdate,
        data: {
          name: 'books-api',
          healthStatus: 'down' as const,
          responseTimeMs: null,
          lastChecked: '2026-03-17T00:00:00Z',
        },
      },
      rib.state
    )

    const route = plan.newState.local.routes[0]
    expect(route.region).toBe('us-east')
    expect(route.tags).toEqual(['prod'])
    expect(route.protocol).toBe('http:graphql')
    expect(route.healthStatus).toBe('down')
  })

  it('does not generate port operations', () => {
    const rib = makeRib(stateWithRoute())
    const plan = rib.plan(
      {
        action: Actions.LocalRouteHealthUpdate,
        data: {
          name: 'books-api',
          healthStatus: 'up' as const,
          responseTimeMs: 5,
          lastChecked: '2026-03-17T00:00:00Z',
        },
      },
      rib.state
    )

    expect(plan.portOps).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/routing && npx vitest run tests/v2/rib-health-update.test.ts`
Expected: FAIL — `LocalRouteHealthUpdate` action not handled in `plan()`.

- [ ] **Step 3: Add the planner handler**

In `packages/routing/src/v2/rib/rib.ts`:

Add the derived type at line 21 (after `LocalRouteDeleteData`):

```typescript
type LocalRouteHealthUpdateData = Extract<
  Action,
  { action: typeof Actions.LocalRouteHealthUpdate }
>['data']
```

Add the case in the `plan()` switch (after `LocalRouteDelete` case, around line 107):

```typescript
      case Actions.LocalRouteHealthUpdate:
        return this.planLocalRouteHealthUpdate(action.data, state)
```

Add the handler method after `planLocalRouteDelete` (after line 260):

```typescript
  private planLocalRouteHealthUpdate(
    data: LocalRouteHealthUpdateData,
    state: RouteTable
  ): PlanResult {
    const idx = state.local.routes.findIndex((r) => r.name === data.name)
    if (idx === -1) return noChange(state)

    const existing = state.local.routes[idx]

    // No-op if health fields are identical (prevent iBGP churn)
    if (
      existing.healthStatus === data.healthStatus &&
      existing.responseTimeMs === data.responseTimeMs &&
      existing.lastChecked === data.lastChecked
    ) {
      return noChange(state)
    }

    const updated = {
      ...existing,
      healthStatus: data.healthStatus,
      responseTimeMs: data.responseTimeMs,
      lastChecked: data.lastChecked,
    }
    const routes = state.local.routes.map((r, i) => (i === idx ? updated : r))
    const newState: RouteTable = {
      ...state,
      local: { ...state.local, routes },
    }
    return {
      prevState: state,
      newState,
      portOps: NO_PORT_OPS,
      routeChanges: [{ type: 'updated', route: updated }],
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/routing && npx vitest run tests/v2/rib-health-update.test.ts`
Expected: All 5 tests pass.

- [ ] **Step 5: Run all routing tests**

Run: `cd packages/routing && bun test`
Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
gt commit --no-interactive create -m "feat(routing): add planLocalRouteHealthUpdate RIB handler"
```

---

## Task 3: Update AdapterHealthChecker to dispatch on status change

**Files:**

- Modify: `apps/orchestrator/src/v2/adapter-health.ts`
- Modify: `apps/orchestrator/tests/v2/adapter-health.test.ts`

- [ ] **Step 1: Add dispatch tests**

Add these tests to `apps/orchestrator/tests/v2/adapter-health.test.ts`:

```typescript
// -------------------------------------------------------------------------
// Dispatch on status change
// -------------------------------------------------------------------------
it('dispatches LocalRouteHealthUpdate when status changes', async () => {
  const dispatchFn = vi.fn().mockResolvedValue(undefined)
  const dispatchChecker = new AdapterHealthChecker({
    intervalMs: 30_000,
    timeoutMs: 3_000,
    dispatchFn,
  })

  // First check: up
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(200)))
  const routes = [makeRoute('alpha')]
  await dispatchChecker.checkAll(routes)

  expect(dispatchFn).toHaveBeenCalledOnce()
  expect(dispatchFn).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'local:route:health-update',
      data: expect.objectContaining({
        name: 'alpha',
        healthStatus: 'up',
      }),
    })
  )

  dispatchChecker.stop()
})

it('does NOT dispatch when status stays the same', async () => {
  const dispatchFn = vi.fn().mockResolvedValue(undefined)
  const dispatchChecker = new AdapterHealthChecker({
    intervalMs: 30_000,
    timeoutMs: 3_000,
    dispatchFn,
  })

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(200)))
  const routes = [makeRoute('alpha')]

  await dispatchChecker.checkAll(routes)
  expect(dispatchFn).toHaveBeenCalledOnce()

  // Second check: still up — no dispatch
  await dispatchChecker.checkAll(routes)
  expect(dispatchFn).toHaveBeenCalledOnce() // still 1, not 2

  dispatchChecker.stop()
})

it('dispatches when status transitions from up to down', async () => {
  const dispatchFn = vi.fn().mockResolvedValue(undefined)
  const dispatchChecker = new AdapterHealthChecker({
    intervalMs: 30_000,
    timeoutMs: 3_000,
    dispatchFn,
  })

  const mockFetch = vi
    .fn()
    .mockResolvedValueOnce(makeMockResponse(200))
    .mockRejectedValueOnce(new Error('timeout'))
  vi.stubGlobal('fetch', mockFetch)

  const routes = [makeRoute('alpha')]

  await dispatchChecker.checkAll(routes)
  expect(dispatchFn).toHaveBeenCalledTimes(1) // up

  await dispatchChecker.checkAll(routes)
  expect(dispatchFn).toHaveBeenCalledTimes(2) // down
  expect(dispatchFn.mock.calls[1][0].data.healthStatus).toBe('down')

  dispatchChecker.stop()
})

it('works without dispatchFn (backward compat)', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(200)))

  const routes = [makeRoute('alpha')]
  await checker.checkAll(routes) // checker has no dispatchFn

  expect(checker.getHealth('alpha')?.healthStatus).toBe('up')
  // No error thrown — it just works without dispatching
})
```

- [ ] **Step 2: Run tests to verify new ones fail**

Run: `cd apps/orchestrator && npx vitest run tests/v2/adapter-health.test.ts`
Expected: New dispatch tests fail (constructor doesn't accept `dispatchFn` yet).

- [ ] **Step 3: Update AdapterHealthChecker**

In `apps/orchestrator/src/v2/adapter-health.ts`:

Update the options interface:

```typescript
interface AdapterHealthCheckerOptions {
  intervalMs: number
  timeoutMs: number
  dispatchFn?: (action: { action: string; data: Record<string, unknown> }) => Promise<unknown>
}
```

At the end of `checkOne()`, after setting the new health in `healthMap`, add dispatch logic. The cleanest way: extract the health-setting into a helper that also handles dispatch.

Replace the `checkOne` method body to track previous status and dispatch on change. After each `this.healthMap.set(name, ...)` call, add:

```typescript
// After setting health, check if status changed and dispatch
const newHealth = this.healthMap.get(name)!
if (this.options.dispatchFn && prevStatus !== newHealth.healthStatus) {
  this.options
    .dispatchFn({
      action: 'local:route:health-update',
      data: {
        name,
        healthStatus: newHealth.healthStatus,
        responseTimeMs: newHealth.responseTimeMs,
        lastChecked: newHealth.lastChecked,
      },
    })
    .catch((error) => {
      console.error(`[AdapterHealthChecker] Failed to dispatch health update for ${name}:`, error)
    })
}
```

The full updated `checkOne` should capture `prevStatus` at the top:

```typescript
  private async checkOne(route: DataChannelDefinition): Promise<void> {
    const { name } = route
    const prevStatus = this.healthMap.get(name)?.healthStatus

    // ... existing logic (skip noHealthEndpoint, skip non-HTTP, build URL, fetch) ...
    // ... all the existing healthMap.set() calls stay the same ...

    // After all branches have set the new health, dispatch if status changed
    const newHealth = this.healthMap.get(name)
    if (this.options.dispatchFn && newHealth && prevStatus !== newHealth.healthStatus) {
      this.options.dispatchFn({
        action: 'local:route:health-update',
        data: {
          name,
          healthStatus: newHealth.healthStatus,
          responseTimeMs: newHealth.responseTimeMs,
          lastChecked: newHealth.lastChecked,
        },
      }).catch((error) => {
        console.error(`[AdapterHealthChecker] Failed to dispatch health update for ${name}:`, error)
      })
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `cd apps/orchestrator && npx vitest run tests/v2/adapter-health.test.ts`
Expected: All tests pass (old + new).

- [ ] **Step 5: Commit**

```bash
gt commit --no-interactive create -m "feat(orchestrator): dispatch LocalRouteHealthUpdate on health status change"
```

---

## Task 4: Wire dispatchFn in catalyst-service

**Files:**

- Modify: `apps/orchestrator/src/v2/catalyst-service.ts`

- [ ] **Step 1: Pass dispatchFn when creating health checker**

In `apps/orchestrator/src/v2/catalyst-service.ts`, update the health checker initialization to pass the bus dispatch function:

```typescript
const adapterHealthConfig = this.config.orchestrator?.adapterHealth
if (adapterHealthConfig?.enabled !== false) {
  this._healthChecker = new AdapterHealthChecker({
    intervalMs: adapterHealthConfig?.intervalMs ?? 30_000,
    timeoutMs: adapterHealthConfig?.timeoutMs ?? 3_000,
    dispatchFn: (action) => this._v2.bus.dispatch(action as any).then(() => {}),
  })
  // Health checks read a snapshot of routes (safe). Status changes are
  // dispatched into the bus via dispatchFn, which updates the RIB and
  // triggers iBGP propagation to peers.
  this._healthChecker.start(() => this._v2.bus.getStateSnapshot().local.routes)
}
```

- [ ] **Step 2: Run orchestrator tests**

Run: `cd apps/orchestrator && npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
gt commit --no-interactive create -m "feat(orchestrator): wire dispatchFn for health status iBGP propagation"
```

---

## Task 5: End-to-end propagation test

**Files:**

- Modify: `apps/orchestrator/tests/v2/adapter-health-propagation.test.ts`

- [ ] **Step 1: Add a test that dispatches LocalRouteHealthUpdate and verifies peer receives it**

Add to `apps/orchestrator/tests/v2/adapter-health-propagation.test.ts`:

```typescript
it('health status update propagates to connected peer', async () => {
  const { bus, transport } = makeBus(configA)
  await connectPeer(bus, peerB)

  // First: create the route
  await bus.dispatch({
    action: Actions.LocalRouteCreate,
    data: {
      name: 'books',
      protocol: 'http:graphql' as const,
      endpoint: 'http://books:4001/graphql',
    },
  })

  // Clear transport calls from route creation
  transport.clearCalls()

  // Now: dispatch health update
  await bus.dispatch({
    action: Actions.LocalRouteHealthUpdate,
    data: {
      name: 'books',
      healthStatus: 'down' as const,
      responseTimeMs: null,
      lastChecked: '2026-03-17T02:20:00Z',
    },
  })

  // Verify the update was sent to the peer
  const updateCalls = transport.getCalls().filter((c) => c.method === 'sendUpdate')
  expect(updateCalls).toHaveLength(1)

  const updates = (updateCalls[0] as any).message.updates
  expect(updates).toHaveLength(1)
  expect(updates[0].route.name).toBe('books')
  expect(updates[0].route.healthStatus).toBe('down')
  expect(updates[0].route.responseTimeMs).toBeNull()
})
```

Note: You may need to check what methods `MockPeerTransport` provides. It may use `calls` array or a `getLastUpdate()` method. Adapt the assertion to match the actual mock API — read `apps/orchestrator/src/v2/transport.ts` for the `MockPeerTransport` class.

- [ ] **Step 2: Run propagation tests**

Run: `cd apps/orchestrator && npx vitest run tests/v2/adapter-health-propagation.test.ts`
Expected: All tests pass including the new one.

- [ ] **Step 3: Commit**

```bash
gt commit --no-interactive create -m "test(orchestrator): verify health status update propagates to peer via iBGP"
```

---

## Task 6: Manual testing with two-node cluster

- [ ] **Step 1: Rebuild Docker images**

```bash
docker compose -f docker-compose/two-node.compose.yaml build auth node-a node-b web-ui
```

- [ ] **Step 2: Start cluster with auth**

Use the init script pattern from earlier testing. Start auth, extract token, start orchestrators with `CATALYST_AUTH_ENDPOINT` and `CATALYST_SYSTEM_TOKEN`, start web-ui.

```bash
docker compose -f docker-compose/two-node.compose.yaml up -d auth books-service movies-service gateway-a gateway-b envoy-service envoy-proxy otel-collector
sleep 15
SYSTEM_TOKEN=$(docker compose -f docker-compose/two-node.compose.yaml logs auth 2>&1 | grep -o 'CATALYST_SYSTEM_TOKEN=[^ ]*' | head -1 | sed 's/CATALYST_SYSTEM_TOKEN=//')
export CATALYST_SYSTEM_TOKEN="$SYSTEM_TOKEN" CATALYST_AUTH_ENDPOINT="ws://auth:4020/rpc"
docker compose -f docker-compose/two-node.compose.yaml up -d node-a node-b
sleep 15
docker compose -f docker-compose/two-node.compose.yaml up -d web-ui
sleep 10
```

Note: This requires the `console.log(CATALYST_SYSTEM_TOKEN=...)` line temporarily added to `packages/authorization/src/service/service.ts` for token extraction. Remember to revert after testing.

- [ ] **Step 3: Register routes and set up peering**

```bash
DC_TOKEN=$(NO_COLOR=1 bun apps/cli/src/index.ts --auth-url ws://localhost:4020/rpc --token "$SYSTEM_TOKEN" auth token mint route-admin --principal "CATALYST::DATA_CUSTODIAN" --name "Route Admin" --type service --expires-in 24h --trusted-domains "dev.catalyst.local" 2>&1 | tail -1)

bun apps/cli/src/index.ts --orchestrator-url ws://localhost:3001/rpc --token "$DC_TOKEN" node route create books-api http://books-service:8080/graphql --protocol http:graphql

bun apps/cli/src/index.ts --orchestrator-url ws://localhost:3002/rpc --token "$DC_TOKEN" node route create movies-api http://movies-service:8080/graphql --protocol http:graphql

# Set up peering (mint node + node-custodian tokens, create peers)
# Follow the pattern from the earlier manual test session
```

- [ ] **Step 4: Verify health propagates to peer**

Wait 35 seconds for health checks, then:

```bash
# Node A should show books-api as "up" (local)
curl -s http://localhost:3001/api/state | python3 -m json.tool

# Node B should show books-api as "up" in internal routes (from peer)
curl -s http://localhost:3002/api/state | python3 -m json.tool
```

Verify that node-b's internal routes include `healthStatus: "up"` for books-api.

- [ ] **Step 5: Verify status change propagates**

```bash
docker compose -f docker-compose/two-node.compose.yaml stop books-service
sleep 35
# Node A: books-api should be "down" (local)
curl -s http://localhost:3001/api/state | jq '.routes.local[0]'
# Node B: books-api should be "down" in internal routes
curl -s http://localhost:3002/api/state | jq '.routes.internal[0]'
```

- [ ] **Step 6: Verify recovery propagates**

```bash
docker compose -f docker-compose/two-node.compose.yaml start books-service
sleep 35
# Both nodes should show books-api as "up" again
```

- [ ] **Step 7: Open status page and verify UI**

Open http://localhost:8080, check Adapters tab shows both local and remote adapters with correct health badges and origin.

- [ ] **Step 8: Clean up**

```bash
docker compose -f docker-compose/two-node.compose.yaml down -v
```

Revert the temporary `console.log(CATALYST_SYSTEM_TOKEN=...)` line in `packages/authorization/src/service/service.ts`.

- [ ] **Step 9: Submit**

```bash
gt submit --no-interactive --stack
```
