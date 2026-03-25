import { describe, it, expect } from 'vitest'
import { ActionQueue } from '../../../src/v2/rib/action-queue.js'

describe('ActionQueue', () => {
  it('executes operations sequentially', async () => {
    const queue = new ActionQueue()
    const order: number[] = []

    const p1 = queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 50))
      order.push(1)
      return 'first'
    })

    const p2 = queue.enqueue(async () => {
      order.push(2)
      return 'second'
    })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
    expect(r1).toBe('first')
    expect(r2).toBe('second')
  })

  it('propagates errors to caller without blocking queue', async () => {
    const queue = new ActionQueue()

    const p1 = queue.enqueue(async () => {
      throw new Error('fail')
    })

    const p2 = queue.enqueue(async () => 'ok')

    await expect(p1).rejects.toThrow('fail')
    expect(await p2).toBe('ok')
  })

  it('returns values from enqueued operations', async () => {
    const queue = new ActionQueue()
    const result = await queue.enqueue(async () => 42)
    expect(result).toBe(42)
  })
})
