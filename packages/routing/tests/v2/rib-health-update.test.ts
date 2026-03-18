import { describe, it, expect } from 'vitest'
import { RoutingInformationBase } from '../../src/v2/rib/rib.js'
import { Actions } from '../../src/v2/action-types.js'
import type { RouteTable } from '../../src/v2/state.js'

function makeRib(state?: RouteTable) {
  return new RoutingInformationBase({ nodeId: 'node-a', initialState: state })
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
    expect(plan.routeChanges).toHaveLength(1)
    expect(plan.routeChanges[0].type).toBe('updated')
  })

  it('returns noChange for non-existent route', () => {
    const rib = makeRib(stateWithRoute())
    const plan = rib.plan(
      {
        action: Actions.LocalRouteHealthUpdate,
        data: {
          name: 'no-such',
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
