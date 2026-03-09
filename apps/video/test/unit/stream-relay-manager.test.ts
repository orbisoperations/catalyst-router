import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StreamRelayManager } from '../../src/stream-relay-manager.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROUTE_KEY = 'node-a/cam-front'
const DEFAULT_GRACE_PERIOD_MS = 30_000

interface RelayManagerCallbacks {
  onRelayStart: (routeKey: string) => Promise<void>
  onRelayTeardown: (routeKey: string) => Promise<void>
  deletePath?: (name: string) => Promise<void>
}

function makeCallbacks(): RelayManagerCallbacks & {
  startedRelays: string[]
  tornDownRelays: string[]
  deletedPaths: string[]
} {
  const startedRelays: string[] = []
  const tornDownRelays: string[] = []
  const deletedPaths: string[] = []
  return {
    startedRelays,
    tornDownRelays,
    deletedPaths,
    onRelayStart: vi.fn(async (routeKey: string) => {
      startedRelays.push(routeKey)
    }),
    onRelayTeardown: vi.fn(async (routeKey: string) => {
      tornDownRelays.push(routeKey)
    }),
    deletePath: vi.fn(async (name: string) => {
      deletedPaths.push(name)
    }),
  }
}

// ---------------------------------------------------------------------------
// Viewer lifecycle
// ---------------------------------------------------------------------------

describe('StreamRelayManager - viewer lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('first viewer subscribes -> relay starts (activeViewers = 1)', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    await manager.addViewer(ROUTE_KEY)

    const session = manager.getSession(ROUTE_KEY)
    expect(session).toBeDefined()
    expect(session!.activeViewers).toBe(1)
    expect(callbacks.onRelayStart).toHaveBeenCalledTimes(1)
    expect(callbacks.onRelayStart).toHaveBeenCalledWith(ROUTE_KEY)
  })

  it('second viewer subscribes -> relay reused (activeViewers = 2)', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    await manager.addViewer(ROUTE_KEY)
    await manager.addViewer(ROUTE_KEY)

    const session = manager.getSession(ROUTE_KEY)
    expect(session!.activeViewers).toBe(2)
    expect(callbacks.onRelayStart).toHaveBeenCalledTimes(1)
  })

  it('one viewer disconnects -> activeViewers decremented', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    await manager.addViewer(ROUTE_KEY)
    await manager.addViewer(ROUTE_KEY)
    manager.removeViewer(ROUTE_KEY)

    const session = manager.getSession(ROUTE_KEY)
    expect(session!.activeViewers).toBe(1)
    expect(callbacks.onRelayTeardown).not.toHaveBeenCalled()
  })

  it('last viewer disconnects -> grace period timer starts', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    await manager.addViewer(ROUTE_KEY)
    manager.removeViewer(ROUTE_KEY)

    const session = manager.getSession(ROUTE_KEY)
    expect(session).toBeDefined()
    expect(session!.activeViewers).toBe(0)
    expect(session!.gracePeriodTimer).not.toBeNull()
    expect(callbacks.onRelayTeardown).not.toHaveBeenCalled()
  })

  it('viewer reconnects during grace period -> timer cancelled, relay continues', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    await manager.addViewer(ROUTE_KEY)
    manager.removeViewer(ROUTE_KEY)

    vi.advanceTimersByTime(15_000)

    await manager.addViewer(ROUTE_KEY)

    const session = manager.getSession(ROUTE_KEY)
    expect(session!.activeViewers).toBe(1)
    expect(session!.gracePeriodTimer).toBeNull()

    vi.advanceTimersByTime(20_000)
    expect(callbacks.onRelayTeardown).not.toHaveBeenCalled()
    expect(callbacks.onRelayStart).toHaveBeenCalledTimes(1)
  })

  it('grace period expires -> relay torn down', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    await manager.addViewer(ROUTE_KEY)
    manager.removeViewer(ROUTE_KEY)

    vi.advanceTimersByTime(DEFAULT_GRACE_PERIOD_MS + 1)

    expect(callbacks.onRelayTeardown).toHaveBeenCalledTimes(1)
    expect(callbacks.onRelayTeardown).toHaveBeenCalledWith(ROUTE_KEY)
    expect(manager.getSession(ROUTE_KEY)).toBeUndefined()
  })

  it('custom grace period is respected', async () => {
    const customGracePeriodMs = 60_000
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager({ relayGracePeriodMs: customGracePeriodMs }, callbacks)

    await manager.addViewer(ROUTE_KEY)
    manager.removeViewer(ROUTE_KEY)

    vi.advanceTimersByTime(DEFAULT_GRACE_PERIOD_MS)
    expect(callbacks.onRelayTeardown).not.toHaveBeenCalled()

    vi.advanceTimersByTime(customGracePeriodMs - DEFAULT_GRACE_PERIOD_MS + 1)
    expect(callbacks.onRelayTeardown).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('StreamRelayManager - edge cases', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('removeViewer with unknown routeKey is a no-op', () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    manager.removeViewer('unknown-key')
    expect(callbacks.onRelayTeardown).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Source route withdrawal
// ---------------------------------------------------------------------------

describe('StreamRelayManager - source route withdrawal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('source route withdrawn -> immediate relay teardown regardless of viewers', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    await manager.addViewer(ROUTE_KEY)
    await manager.addViewer(ROUTE_KEY)
    expect(manager.getSession(ROUTE_KEY)!.activeViewers).toBe(2)

    await manager.onRouteWithdrawn(ROUTE_KEY)

    expect(callbacks.onRelayTeardown).toHaveBeenCalledTimes(1)
    expect(callbacks.onRelayTeardown).toHaveBeenCalledWith(ROUTE_KEY)
    expect(manager.getSession(ROUTE_KEY)).toBeUndefined()
  })

  it('source route withdrawn during grace period -> immediate teardown, timer cancelled', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    await manager.addViewer(ROUTE_KEY)
    manager.removeViewer(ROUTE_KEY)

    vi.advanceTimersByTime(10_000)
    expect(callbacks.onRelayTeardown).not.toHaveBeenCalled()

    await manager.onRouteWithdrawn(ROUTE_KEY)
    expect(callbacks.onRelayTeardown).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(DEFAULT_GRACE_PERIOD_MS)
    expect(callbacks.onRelayTeardown).toHaveBeenCalledTimes(1)
  })

  it('route withdrawn for unknown route is a no-op', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    await manager.onRouteWithdrawn('nonexistent/stream')
    expect(callbacks.onRelayTeardown).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Multiple concurrent relays
// ---------------------------------------------------------------------------

describe('StreamRelayManager - multiple concurrent relays', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('manages independent sessions for different routes', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    const routeA = 'node-a/cam-front'
    const routeB = 'node-a/cam-rear'

    await manager.addViewer(routeA)
    await manager.addViewer(routeB)
    await manager.addViewer(routeB)

    expect(manager.getSession(routeA)!.activeViewers).toBe(1)
    expect(manager.getSession(routeB)!.activeViewers).toBe(2)
    expect(callbacks.onRelayStart).toHaveBeenCalledTimes(2)

    manager.removeViewer(routeA)
    expect(manager.getSession(routeA)!.activeViewers).toBe(0)
    expect(manager.getSession(routeB)!.activeViewers).toBe(2)

    vi.advanceTimersByTime(DEFAULT_GRACE_PERIOD_MS + 1)
    expect(callbacks.onRelayTeardown).toHaveBeenCalledTimes(1)
    expect(callbacks.onRelayTeardown).toHaveBeenCalledWith(routeA)

    expect(manager.getSession(routeB)!.activeViewers).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// T029: New methods - adopt, teardownAll, startGracePeriod
// ---------------------------------------------------------------------------

describe('StreamRelayManager - adopt', () => {
  it('creates a session with given viewer count, no onRelayStart callback', () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    manager.adopt('node-b/cam-front', 3)

    const session = manager.getSession('node-b/cam-front')
    expect(session).toBeDefined()
    expect(session!.activeViewers).toBe(3)
    expect(session!.gracePeriodTimer).toBeNull()
    expect(callbacks.onRelayStart).not.toHaveBeenCalled()
  })

  it('updates viewer count for already-adopted session', () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    manager.adopt('node-b/cam-front', 2)
    manager.adopt('node-b/cam-front', 5)

    const session = manager.getSession('node-b/cam-front')
    expect(session!.activeViewers).toBe(5)
    expect(callbacks.onRelayStart).not.toHaveBeenCalled()
  })

  it('adopted session participates in normal viewer lifecycle', async () => {
    vi.useFakeTimers()
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    manager.adopt('node-b/cam-front', 1)
    manager.removeViewer('node-b/cam-front')

    expect(manager.getSession('node-b/cam-front')!.activeViewers).toBe(0)
    expect(manager.getSession('node-b/cam-front')!.gracePeriodTimer).not.toBeNull()

    vi.advanceTimersByTime(DEFAULT_GRACE_PERIOD_MS + 1)
    expect(callbacks.onRelayTeardown).toHaveBeenCalledWith('node-b/cam-front')
    vi.useRealTimers()
  })
})

describe('StreamRelayManager - teardownAll', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('tears down all sessions and calls deletePath for each', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    await manager.addViewer('node-a/cam-front')
    await manager.addViewer('node-b/cam-rear')

    await manager.teardownAll()

    expect(callbacks.deletePath).toHaveBeenCalledTimes(2)
    expect(callbacks.deletePath).toHaveBeenCalledWith('node-a/cam-front')
    expect(callbacks.deletePath).toHaveBeenCalledWith('node-b/cam-rear')
    expect(callbacks.onRelayTeardown).toHaveBeenCalledTimes(2)
    expect(manager.getSession('node-a/cam-front')).toBeUndefined()
    expect(manager.getSession('node-b/cam-rear')).toBeUndefined()
  })

  it('clears grace period timers during teardownAll', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    await manager.addViewer('node-a/cam-front')
    manager.removeViewer('node-a/cam-front') // starts grace period

    await manager.teardownAll()

    // After teardownAll, advancing timers should NOT cause double teardown
    vi.advanceTimersByTime(DEFAULT_GRACE_PERIOD_MS + 1)
    // teardownAll called it once, grace period should not fire again
    expect(callbacks.onRelayTeardown).toHaveBeenCalledTimes(1)
  })

  it('handles empty sessions gracefully', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    await manager.teardownAll()

    expect(callbacks.deletePath).not.toHaveBeenCalled()
    expect(callbacks.onRelayTeardown).not.toHaveBeenCalled()
  })
})

describe('StreamRelayManager - startGracePeriod', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts grace period timer for existing session', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    await manager.addViewer(ROUTE_KEY)
    manager.startGracePeriod(ROUTE_KEY)

    const session = manager.getSession(ROUTE_KEY)
    expect(session!.activeViewers).toBe(0)
    expect(session!.gracePeriodTimer).not.toBeNull()

    vi.advanceTimersByTime(DEFAULT_GRACE_PERIOD_MS + 1)
    expect(callbacks.onRelayTeardown).toHaveBeenCalledWith(ROUTE_KEY)
    expect(manager.getSession(ROUTE_KEY)).toBeUndefined()
  })

  it('is a no-op for unknown session', () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    // Should not throw
    manager.startGracePeriod('unknown/stream')
    expect(callbacks.onRelayTeardown).not.toHaveBeenCalled()
  })

  it('replaces existing grace period timer', async () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    await manager.addViewer(ROUTE_KEY)
    manager.removeViewer(ROUTE_KEY) // starts first grace period

    vi.advanceTimersByTime(10_000)
    manager.startGracePeriod(ROUTE_KEY) // restarts grace period

    // Advance to where first timer would have expired
    vi.advanceTimersByTime(DEFAULT_GRACE_PERIOD_MS - 10_000)
    expect(callbacks.onRelayTeardown).not.toHaveBeenCalled()

    // Advance to where second timer expires
    vi.advanceTimersByTime(10_001)
    expect(callbacks.onRelayTeardown).toHaveBeenCalledTimes(1)
  })

  it('works with adopted sessions', () => {
    const callbacks = makeCallbacks()
    const manager = new StreamRelayManager(
      { relayGracePeriodMs: DEFAULT_GRACE_PERIOD_MS },
      callbacks
    )

    manager.adopt(ROUTE_KEY, 0)
    manager.startGracePeriod(ROUTE_KEY)

    const session = manager.getSession(ROUTE_KEY)
    expect(session!.gracePeriodTimer).not.toBeNull()

    vi.advanceTimersByTime(DEFAULT_GRACE_PERIOD_MS + 1)
    expect(callbacks.onRelayTeardown).toHaveBeenCalledWith(ROUTE_KEY)
  })
})
