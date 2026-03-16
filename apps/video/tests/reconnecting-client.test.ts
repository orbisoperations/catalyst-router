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
})
