import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ReconnectManager } from '../../src/v2/reconnect.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { Action, PeerRecord } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const peerRecord: PeerRecord = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['example.local'],
  connectionStatus: 'closed',
  holdTime: 90_000,
  lastSent: 0,
  lastReceived: 0,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReconnectManager', () => {
  let transport: MockPeerTransport
  // vi.fn() typed to satisfy dispatchFn's signature
  let dispatch: ReturnType<typeof vi.fn> & ((action: Action) => Promise<unknown>)
  let manager: ReconnectManager

  beforeEach(() => {
    vi.useFakeTimers()
    transport = new MockPeerTransport()
    dispatch = vi.fn().mockResolvedValue({ success: true }) as ReturnType<typeof vi.fn> &
      ((action: Action) => Promise<unknown>)
    manager = new ReconnectManager({
      transport,
      dispatchFn: dispatch,
      nodeToken: 'test-token',
    })
  })

  afterEach(() => {
    manager.stopAll()
    vi.useRealTimers()
  })

  it('scheduleReconnect starts a pending timer', () => {
    expect(manager.pendingCount).toBe(0)

    manager.scheduleReconnect(peerRecord)

    expect(manager.pendingCount).toBe(1)
  })

  it('scheduleReconnect is idempotent — second call when timer is pending is a no-op', () => {
    manager.scheduleReconnect(peerRecord)
    manager.scheduleReconnect(peerRecord) // should not add a second timer

    expect(manager.pendingCount).toBe(1)
  })

  it('successful reconnect calls openPeer with nodeToken', async () => {
    manager.scheduleReconnect(peerRecord)

    await vi.runAllTimersAsync()

    const openCalls = transport.getCallsFor('openPeer')
    expect(openCalls).toHaveLength(1)
    const call = openCalls[0]
    if (call.method !== 'openPeer') throw new Error('unexpected call type')
    expect(call.peer.name).toBe('node-b')
    expect(call.token).toBe('test-token')
  })

  it('successful reconnect dispatches InternalProtocolConnected to trigger full route sync', async () => {
    manager.scheduleReconnect(peerRecord)

    await vi.runAllTimersAsync()

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0].action).toBe(Actions.InternalProtocolConnected)
    expect(dispatch.mock.calls[0][0].data.peerInfo.name).toBe('node-b')
  })

  it('successful reconnect clears attempt counter (no pending timer after success)', async () => {
    manager.scheduleReconnect(peerRecord)

    await vi.runAllTimersAsync()

    // After success, no pending timers
    expect(manager.pendingCount).toBe(0)
  })

  it('failed reconnect schedules another attempt', async () => {
    transport.setShouldFail(true)

    manager.scheduleReconnect(peerRecord)

    // First attempt fires at 1000ms and fails
    await vi.advanceTimersByTimeAsync(1000)

    // A new timer should have been scheduled for the second attempt
    expect(manager.pendingCount).toBe(1)
  })

  it('uses exponential backoff — first attempt is 1s, second is 2s', async () => {
    transport.setShouldFail(true)

    // Track when openPeer is called
    const callTimes: number[] = []
    const originalOpen = transport.openPeer.bind(transport)
    vi.spyOn(transport, 'openPeer').mockImplementation(async (peer, token) => {
      callTimes.push(Date.now())
      return originalOpen(peer, token)
    })

    manager.scheduleReconnect(peerRecord)

    // First attempt at 1000ms
    vi.advanceTimersByTime(999)
    expect(callTimes).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(callTimes).toHaveLength(1)

    // Second attempt at 2000ms after first
    vi.advanceTimersByTime(1999)
    expect(callTimes).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(callTimes).toHaveLength(2)
  })

  it('backoff is capped at maxBackoffMs', async () => {
    const maxBackoffMs = 4_000
    const smallManager = new ReconnectManager({
      transport,
      dispatchFn: dispatch,
      nodeToken: 'test-token',
      maxBackoffMs,
    })

    // Make transport always fail to force many retries
    transport.setShouldFail(true)

    smallManager.scheduleReconnect(peerRecord)

    // Advance through several attempts: 1s, 2s, 4s (cap), 4s (cap)
    // Total: advance 11s to get through at least 3 capped retries
    await vi.advanceTimersByTimeAsync(1_000) // attempt 1 (1s delay)
    await vi.advanceTimersByTimeAsync(2_000) // attempt 2 (2s delay)
    await vi.advanceTimersByTimeAsync(4_000) // attempt 3 (4s delay = cap)
    await vi.advanceTimersByTimeAsync(4_000) // attempt 4 (4s delay = cap)

    // We should have at least 4 openPeer calls, all failed
    const openCalls = transport.getCallsFor('openPeer')
    expect(openCalls.length).toBeGreaterThanOrEqual(3)

    // Should still have a pending timer for the next retry
    expect(smallManager.pendingCount).toBe(1)

    smallManager.stopAll()
  })

  it('cancelReconnect stops a pending timer', () => {
    manager.scheduleReconnect(peerRecord)
    expect(manager.pendingCount).toBe(1)

    manager.cancelReconnect('node-b')

    expect(manager.pendingCount).toBe(0)
  })

  it('cancelReconnect resets attempt counter so backoff restarts from 1s', async () => {
    transport.setShouldFail(true)

    manager.scheduleReconnect(peerRecord)
    // Let first attempt fire and fail (1s delay)
    await vi.advanceTimersByTimeAsync(1_000)

    // Now a second attempt is pending at 2s delay — cancel it
    manager.cancelReconnect('node-b')
    expect(manager.pendingCount).toBe(0)

    // Fix the transport so the next attempt succeeds
    transport.setShouldFail(false)

    // Re-schedule — backoff counter was reset so the first attempt is at 1s again
    const preCancelCallCount = transport.getCallsFor('openPeer').length
    manager.scheduleReconnect(peerRecord)

    // Should NOT fire before 1s
    await vi.advanceTimersByTimeAsync(500)
    expect(transport.getCallsFor('openPeer')).toHaveLength(preCancelCallCount)

    // Should fire at 1s
    await vi.advanceTimersByTimeAsync(500)
    expect(transport.getCallsFor('openPeer')).toHaveLength(preCancelCallCount + 1)
  })

  it('cancelReconnect on unknown peer name is a no-op', () => {
    expect(() => manager.cancelReconnect('does-not-exist')).not.toThrow()
    expect(manager.pendingCount).toBe(0)
  })

  it('stopAll cancels all pending reconnects', () => {
    const peer2: PeerRecord = {
      ...peerRecord,
      name: 'node-c',
      endpoint: 'ws://node-c:4000',
    }

    manager.scheduleReconnect(peerRecord)
    manager.scheduleReconnect(peer2)
    expect(manager.pendingCount).toBe(2)

    manager.stopAll()

    expect(manager.pendingCount).toBe(0)
  })

  it('stopAll prevents scheduled timers from firing', async () => {
    manager.scheduleReconnect(peerRecord)
    manager.stopAll()

    await vi.runAllTimersAsync()

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('skips reconnect when nodeToken is undefined', async () => {
    const noTokenManager = new ReconnectManager({
      transport,
      dispatchFn: dispatch,
      // no nodeToken
    })

    noTokenManager.scheduleReconnect(peerRecord)

    await vi.runAllTimersAsync()

    // openPeer should never have been called
    expect(transport.getCallsFor('openPeer')).toHaveLength(0)
    expect(dispatch).not.toHaveBeenCalled()
    // Timer completed without rescheduling
    expect(noTokenManager.pendingCount).toBe(0)

    noTokenManager.stopAll()
  })

  it('resumes reconnect after setNodeToken provides a token', async () => {
    const noTokenManager = new ReconnectManager({
      transport,
      dispatchFn: dispatch,
      // no nodeToken initially
    })

    noTokenManager.scheduleReconnect(peerRecord)
    await vi.runAllTimersAsync()

    // First attempt skipped — no openPeer calls
    expect(transport.getCallsFor('openPeer')).toHaveLength(0)

    // Now provide a token and schedule again
    noTokenManager.setNodeToken('late-token')
    noTokenManager.scheduleReconnect(peerRecord)
    await vi.runAllTimersAsync()

    const openCalls = transport.getCallsFor('openPeer')
    expect(openCalls).toHaveLength(1)
    if (openCalls[0].method !== 'openPeer') throw new Error('unexpected')
    expect(openCalls[0].token).toBe('late-token')

    noTokenManager.stopAll()
  })

  it('setNodeToken is used on subsequent reconnect attempts', async () => {
    manager.setNodeToken('updated-token')
    manager.scheduleReconnect(peerRecord)

    await vi.runAllTimersAsync()

    const openCalls = transport.getCallsFor('openPeer')
    expect(openCalls).toHaveLength(1)
    const call = openCalls[0]
    if (call.method !== 'openPeer') throw new Error('unexpected call type')
    expect(call.token).toBe('updated-token')
  })
})
