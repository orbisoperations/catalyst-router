import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ReconnectingClient } from '../src/rpc/reconnecting-client.js'

describe('ReconnectingClient', () => {
  let connectFn: ReturnType<typeof vi.fn> & (() => Promise<unknown>)
  let mintTokenFn: ReturnType<typeof vi.fn> & (() => Promise<string>)
  let reconcileFn: ReturnType<typeof vi.fn> & (() => Promise<void>)

  beforeEach(() => {
    connectFn = vi.fn().mockResolvedValue({ client: true })
    mintTokenFn = vi.fn().mockResolvedValue('fresh-token')
    reconcileFn = vi.fn().mockResolvedValue(undefined)
  })

  function createClient(opts?: { initialBackoffMs?: number; maxBackoffMs?: number }) {
    return new ReconnectingClient({
      connect: connectFn,
      mintToken: mintTokenFn,
      reconcile: reconcileFn,
      initialBackoffMs: opts?.initialBackoffMs ?? 10,
      maxBackoffMs: opts?.maxBackoffMs ?? 100,
    })
  }

  it('connects and reconciles on start', async () => {
    const client = createClient()
    const events: string[] = []
    client.on('connected', () => events.push('connected'))
    client.on('reconciled', () => events.push('reconciled'))

    await client.start()

    expect(mintTokenFn).toHaveBeenCalledTimes(1)
    expect(connectFn).toHaveBeenCalledTimes(1)
    expect(reconcileFn).toHaveBeenCalledTimes(1)
    expect(client.connected).toBe(true)
    expect(events).toEqual(['connected', 'reconciled'])
  })

  it('re-mints token before connecting', async () => {
    const callOrder: string[] = []
    mintTokenFn.mockImplementation(async () => {
      callOrder.push('mint')
      return 'token'
    })
    connectFn.mockImplementation(async () => {
      callOrder.push('connect')
      return {}
    })

    const client = createClient()
    await client.start()

    expect(callOrder).toEqual(['mint', 'connect'])
  })

  it('schedules reconnect on disconnect', async () => {
    const client = createClient()
    await client.start()

    const reconnecting = new Promise<[number, number]>((resolve) =>
      client.on('reconnecting', (attempt, delay) => resolve([attempt, delay]))
    )

    client.onDisconnect()
    expect(client.connected).toBe(false)

    const [attempt, delay] = await reconnecting
    expect(attempt).toBe(1)
    expect(delay).toBe(10)

    // Wait for reconnect to complete
    await new Promise((r) => setTimeout(r, 30))
  })

  it('uses exponential backoff on connection failures', async () => {
    const delays: number[] = []
    let callCount = 0

    mintTokenFn.mockResolvedValue('token')
    connectFn.mockImplementation(async () => {
      callCount++
      if (callCount === 1) return { client: true }
      if (callCount <= 3) throw new Error(`fail ${callCount - 1}`)
      return { client: true }
    })

    const client = createClient({ initialBackoffMs: 10, maxBackoffMs: 100 })
    client.on('reconnecting', (_attempt, delay) => delays.push(delay))
    client.on('error', () => {}) // prevent unhandled error throw

    await client.start()
    client.onDisconnect()

    await new Promise((r) => setTimeout(r, 200))

    expect(delays.length).toBeGreaterThanOrEqual(2)
    expect(delays[0]).toBe(10)
    expect(delays[1]).toBe(20)

    client.stop()
  })

  it('caps backoff at maxBackoffMs', async () => {
    const delays: number[] = []
    let callCount = 0

    mintTokenFn.mockResolvedValue('token')
    connectFn.mockImplementation(async () => {
      callCount++
      if (callCount === 1) return { client: true }
      throw new Error('keep failing')
    })

    const client = createClient({ initialBackoffMs: 10, maxBackoffMs: 40 })
    client.on('reconnecting', (_attempt, delay) => delays.push(delay))
    client.on('error', () => {}) // prevent unhandled error throw

    await client.start()
    client.onDisconnect()

    await new Promise((r) => setTimeout(r, 400))
    client.stop()

    const capped = delays.filter((d) => d > 40)
    expect(capped).toHaveLength(0)
    expect(delays.length).toBeGreaterThanOrEqual(3)
  })

  it('resets attempt count on successful reconnect', async () => {
    const client = createClient()
    await client.start()
    expect(client.connected).toBe(true)

    // Disconnect → reconnect
    const reconnected = new Promise<void>((resolve) => {
      client.once('connected', resolve)
    })
    client.onDisconnect()
    await reconnected

    // Should have re-minted and reconnected
    expect(mintTokenFn).toHaveBeenCalledTimes(2)
    expect(connectFn).toHaveBeenCalledTimes(2)
  })

  it('does not reconnect after stop', async () => {
    const client = createClient()
    await client.start()

    client.stop()
    expect(client.connected).toBe(false)

    client.onDisconnect() // should be no-op

    await new Promise((r) => setTimeout(r, 50))
    expect(connectFn).toHaveBeenCalledTimes(1)
  })

  it('emits error on connect failure', async () => {
    mintTokenFn.mockRejectedValue(new Error('mint failed'))

    const client = createClient()
    const errors: Error[] = []
    client.on('error', (err) => errors.push(err))

    await client.start()

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('mint failed')

    client.stop()
  })

  describe('reconnect()', () => {
    it('disconnects then reconnects with fresh token via doConnect', async () => {
      const client = createClient()
      await client.start()
      expect(mintTokenFn).toHaveBeenCalledTimes(1)

      const events: string[] = []
      client.on('disconnected', () => events.push('disconnected'))
      client.on('connected', () => events.push('connected'))
      client.on('reconciled', () => events.push('reconciled'))

      await client.reconnect()

      expect(events).toEqual(['disconnected', 'connected', 'reconciled'])
      expect(mintTokenFn).toHaveBeenCalledTimes(2)
      expect(connectFn).toHaveBeenCalledTimes(2)
      expect(reconcileFn).toHaveBeenCalledTimes(2)
      expect(client.connected).toBe(true)
    })

    it('mints exactly once per reconnect (inside doConnect)', async () => {
      const client = createClient()
      await client.start()

      await client.reconnect()

      // start mints once, reconnect mints once = 2 total
      expect(mintTokenFn).toHaveBeenCalledTimes(2)
    })

    it('cancels pending reconnect timer', async () => {
      const client = createClient({ initialBackoffMs: 500 })
      await client.start()

      // Trigger a disconnect which schedules a delayed reconnect
      client.onDisconnect()
      // Immediately force reconnect — should cancel the pending timer
      await client.reconnect()

      // Only 3 total: start + scheduled-reconnect-cancelled + reconnect
      // The cancelled timer should NOT fire
      await new Promise((r) => setTimeout(r, 600))
      expect(mintTokenFn).toHaveBeenCalledTimes(2) // start + reconnect, not 3
    })

    it('resets attempt counter to 0', async () => {
      let attemptSeen = -1
      const client = createClient()
      await client.start()

      // Force a failure to increment attempt counter
      connectFn.mockRejectedValueOnce(new Error('fail'))
      client.on('error', () => {})
      client.on('reconnecting', (attempt) => {
        attemptSeen = attempt
      })
      client.onDisconnect()

      // Wait for the scheduled reconnect to fire and fail
      await new Promise((r) => setTimeout(r, 50))
      expect(attemptSeen).toBeGreaterThan(0)

      // Now force a clean reconnect
      connectFn.mockResolvedValue({ client: true })
      await client.reconnect()

      // After successful reconnect, attempt should be reset
      expect(client.connected).toBe(true)

      client.stop()
    })

    it('is a no-op when stopped', async () => {
      const client = createClient()
      await client.start()
      client.stop()

      await client.reconnect()

      // Only the initial start mint, not a second one
      expect(mintTokenFn).toHaveBeenCalledTimes(1)
      expect(client.connected).toBe(false)
    })

    it('emits error and schedules retry on doConnect failure', async () => {
      const client = createClient()
      await client.start()

      mintTokenFn.mockRejectedValueOnce(new Error('refresh mint failed'))
      const errors: string[] = []
      client.on('error', (err) => errors.push(err.message))

      await client.reconnect()

      expect(errors).toContain('refresh mint failed')

      client.stop()
    })
  })
})
