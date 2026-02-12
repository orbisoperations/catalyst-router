import { describe, it, expect } from 'bun:test'
import { expandPortRange, createPortAllocator } from '../src/port-allocator.js'

describe('expandPortRange', () => {
  it('expands single ports', () => {
    const result = expandPortRange([8000])
    expect(result).toEqual([8000])
  })

  it('expands tuple ranges', () => {
    const result = expandPortRange([[9000, 9003]])
    expect(result).toEqual([9000, 9001, 9002, 9003])
  })

  it('expands mixed single ports and ranges', () => {
    const result = expandPortRange([8000, [9000, 9002], 10000])
    expect(result).toEqual([8000, 9000, 9001, 9002, 10000])
  })

  it('handles single-element tuple (start equals end)', () => {
    const result = expandPortRange([[5000, 5000]])
    expect(result).toEqual([5000])
  })

  it('expands multiple ranges', () => {
    const result = expandPortRange([
      [100, 102],
      [200, 201],
    ])
    expect(result).toEqual([100, 101, 102, 200, 201])
  })

  it('returns empty array for empty input', () => {
    const result = expandPortRange([])
    expect(result).toEqual([])
  })
})

describe('createPortAllocator', () => {
  describe('creation', () => {
    it('creates allocator from PortEntry array', () => {
      const allocator = createPortAllocator([8000, [9000, 9002]])
      expect(allocator).toBeDefined()
    })

    it('starts with correct availableCount', () => {
      const allocator = createPortAllocator([8000, [9000, 9002]])
      // 8000 + 9000, 9001, 9002 = 4 ports
      expect(allocator.availableCount()).toBe(4)
    })

    it('initially has empty allocations', () => {
      const allocator = createPortAllocator([8000])
      expect(allocator.getAllocations().size).toBe(0)
    })
  })

  describe('allocation', () => {
    it('allocates the first port for a channel', () => {
      const allocator = createPortAllocator([8000, 8001, 8002])
      const result = allocator.allocate('books-api')
      expect(result).toEqual({ success: true, port: 8000 })
    })

    it('allocates sequential ports for different channels', () => {
      const allocator = createPortAllocator([8000, 8001, 8002])
      const first = allocator.allocate('books-api')
      const second = allocator.allocate('movies-api')
      expect(first).toEqual({ success: true, port: 8000 })
      expect(second).toEqual({ success: true, port: 8001 })
    })

    it('is idempotent: same channel returns same port', () => {
      const allocator = createPortAllocator([8000, 8001])
      const first = allocator.allocate('books-api')
      const second = allocator.allocate('books-api')
      expect(first).toEqual({ success: true, port: 8000 })
      expect(second).toEqual({ success: true, port: 8000 })
    })

    it('idempotent allocation does not consume additional ports', () => {
      const allocator = createPortAllocator([8000, 8001])
      allocator.allocate('books-api')
      allocator.allocate('books-api') // idempotent
      expect(allocator.availableCount()).toBe(1)
    })

    it('returns error when pool is exhausted', () => {
      const allocator = createPortAllocator([8000])
      allocator.allocate('books-api')
      const result = allocator.allocate('movies-api')
      expect(result).toEqual({ success: false, error: 'No ports available' })
    })

    it('decrements availableCount on allocation', () => {
      const allocator = createPortAllocator([8000, 8001, 8002])
      expect(allocator.availableCount()).toBe(3)
      allocator.allocate('books-api')
      expect(allocator.availableCount()).toBe(2)
    })
  })

  describe('release', () => {
    it('frees a previously allocated port', () => {
      const allocator = createPortAllocator([8000, 8001])
      allocator.allocate('books-api')
      expect(allocator.availableCount()).toBe(1)
      allocator.release('books-api')
      expect(allocator.availableCount()).toBe(2)
    })

    it('released port becomes available for next allocation', () => {
      const allocator = createPortAllocator([8000])
      allocator.allocate('books-api')
      allocator.release('books-api')
      const result = allocator.allocate('movies-api')
      expect(result).toEqual({ success: true, port: 8000 })
    })

    it('releasing unallocated name is a no-op', () => {
      const allocator = createPortAllocator([8000])
      allocator.release('unknown-service')
      expect(allocator.availableCount()).toBe(1)
    })

    it('getPort returns undefined after release', () => {
      const allocator = createPortAllocator([8000])
      allocator.allocate('books-api')
      allocator.release('books-api')
      expect(allocator.getPort('books-api')).toBeUndefined()
    })
  })

  describe('getters', () => {
    it('getPort returns allocated port', () => {
      const allocator = createPortAllocator([8000, 8001])
      allocator.allocate('books-api')
      expect(allocator.getPort('books-api')).toBe(8000)
    })

    it('getPort returns undefined for unknown channel', () => {
      const allocator = createPortAllocator([8000])
      expect(allocator.getPort('unknown')).toBeUndefined()
    })

    it('getAllocations returns current allocations', () => {
      const allocator = createPortAllocator([8000, 8001])
      allocator.allocate('books-api')
      allocator.allocate('movies-api')
      const allocs = allocator.getAllocations()
      expect(allocs.size).toBe(2)
      expect(allocs.get('books-api')).toBe(8000)
      expect(allocs.get('movies-api')).toBe(8001)
    })

    it('getAllocations returns ReadonlyMap (snapshot)', () => {
      const allocator = createPortAllocator([8000])
      allocator.allocate('books-api')
      const allocs = allocator.getAllocations()
      expect(allocs.get('books-api')).toBe(8000)
    })
  })

  describe('restart recovery', () => {
    it('accepts existing allocations for re-hydration', () => {
      const existing = new Map<string, number>([['books-api', 8001]])
      const allocator = createPortAllocator([8000, 8001, 8002], existing)
      expect(allocator.getPort('books-api')).toBe(8001)
    })

    it('re-hydrated ports are marked as used', () => {
      const existing = new Map<string, number>([['books-api', 8001]])
      const allocator = createPortAllocator([8000, 8001, 8002], existing)
      // 3 total ports minus 1 re-hydrated = 2 available
      expect(allocator.availableCount()).toBe(2)
    })

    it('new allocations skip re-hydrated ports', () => {
      const existing = new Map<string, number>([['books-api', 8000]])
      const allocator = createPortAllocator([8000, 8001, 8002], existing)
      const result = allocator.allocate('movies-api')
      expect(result).toEqual({ success: true, port: 8001 })
    })

    it('re-hydrated allocations appear in getAllocations', () => {
      const existing = new Map<string, number>([
        ['books-api', 8000],
        ['movies-api', 8002],
      ])
      const allocator = createPortAllocator([8000, 8001, 8002], existing)
      const allocs = allocator.getAllocations()
      expect(allocs.size).toBe(2)
      expect(allocs.get('books-api')).toBe(8000)
      expect(allocs.get('movies-api')).toBe(8002)
    })

    it('can allocate after re-hydration fills some ports', () => {
      const existing = new Map<string, number>([
        ['books-api', 8000],
        ['movies-api', 8001],
      ])
      const allocator = createPortAllocator([8000, 8001, 8002], existing)
      const result = allocator.allocate('orders-api')
      expect(result).toEqual({ success: true, port: 8002 })
    })

    it('empty existing allocations map works like fresh allocator', () => {
      const allocator = createPortAllocator([8000, 8001], new Map())
      expect(allocator.availableCount()).toBe(2)
      expect(allocator.getAllocations().size).toBe(0)
    })

    it('ignores re-hydrated ports outside the configured range', () => {
      const existing = new Map<string, number>([['service', 9999]])
      const allocator = createPortAllocator([8000, 8001], existing)
      // Out-of-range port should be dropped entirely
      expect(allocator.getPort('service')).toBeUndefined()
      expect(allocator.getAllocations().size).toBe(0)
      expect(allocator.availableCount()).toBe(2)
    })

    it('releasing a dropped out-of-range re-hydration does not pollute the pool', () => {
      const existing = new Map<string, number>([['service', 9999]])
      const allocator = createPortAllocator([8000, 8001], existing)
      allocator.release('service')
      // Pool should still only contain in-range ports
      const first = allocator.allocate('a')
      const second = allocator.allocate('b')
      const third = allocator.allocate('c')
      expect(first).toEqual({ success: true, port: 8000 })
      expect(second).toEqual({ success: true, port: 8001 })
      expect(third).toEqual({ success: false, error: 'No ports available' })
    })

    it('accepts in-range ports and rejects out-of-range ports in same re-hydration', () => {
      const existing = new Map<string, number>([
        ['books-api', 8000],
        ['rogue-service', 9999],
      ])
      const allocator = createPortAllocator([8000, 8001], existing)
      expect(allocator.getPort('books-api')).toBe(8000)
      expect(allocator.getPort('rogue-service')).toBeUndefined()
      expect(allocator.availableCount()).toBe(1)
    })
  })
})
