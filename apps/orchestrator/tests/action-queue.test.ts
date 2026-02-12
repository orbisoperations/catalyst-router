import { describe, it, expect } from 'bun:test'
import { ActionQueue, type DispatchResult } from '../src/action-queue.js'
import { Actions, type Action } from '@catalyst/routing'

describe('ActionQueue', () => {
  it('serializes two concurrent dispatches so the second sees state from the first', async () => {
    const observed: string[] = []
    let state = 'initial'

    const queue = new ActionQueue(async (action) => {
      observed.push(`start:${action.action}:${state}`)
      // Simulate async work so both actions are in-flight
      await Promise.resolve()
      if (action.action === Actions.LocalRouteCreate) {
        state = 'route-created'
      }
      observed.push(`end:${action.action}:${state}`)
      return { success: true }
    })

    const routeCreate: Action = {
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-a', endpoint: 'http://a', protocol: 'http' },
    }
    const routeDelete: Action = {
      action: Actions.LocalRouteDelete,
      data: { name: 'svc-a', endpoint: 'http://a', protocol: 'http' },
    }

    // Fire both without awaiting — they should serialize, not interleave
    const [resultA, resultB] = await Promise.all([
      queue.enqueue(routeCreate),
      queue.enqueue(routeDelete),
    ])

    expect(resultA).toEqual({ success: true })
    expect(resultB).toEqual({ success: true })

    // Action B must see state after action A completed
    expect(observed).toEqual([
      'start:local:route:create:initial',
      'end:local:route:create:route-created',
      'start:local:route:delete:route-created',
      'end:local:route:delete:route-created',
    ])
  })

  it('resolves a single dispatch immediately with no added latency', async () => {
    let called = false
    const queue = new ActionQueue(async () => {
      called = true
      return { success: true }
    })

    const action: Action = {
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-a', endpoint: 'http://a', protocol: 'http' },
    }

    const result = await queue.enqueue(action)
    expect(called).toBe(true)
    expect(result).toEqual({ success: true })
  })

  it('propagates pipeline rejection to the caller', async () => {
    const queue = new ActionQueue(async () => {
      throw new Error('pipeline exploded')
    })

    const action: Action = {
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-a', endpoint: 'http://a', protocol: 'http' },
    }

    expect(queue.enqueue(action)).rejects.toThrow('pipeline exploded')
  })

  it('continues processing after a rejection', async () => {
    let callCount = 0
    const queue = new ActionQueue(async () => {
      callCount++
      if (callCount === 1) {
        throw new Error('first fails')
      }
      return { success: true }
    })

    const action: Action = {
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-a', endpoint: 'http://a', protocol: 'http' },
    }

    // First dispatch should reject
    const first = queue.enqueue(action)
    // Second dispatch should succeed
    const second = queue.enqueue(action)

    const results = await Promise.allSettled([first, second])

    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('fulfilled')
    expect((results[1] as PromiseFulfilledResult<DispatchResult>).value).toEqual({ success: true })
  })
})
