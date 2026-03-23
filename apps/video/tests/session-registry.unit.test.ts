import { describe, it, expect, beforeEach } from 'vitest'
import { SessionRegistry, type SessionEntry } from '../src/session/session-registry.js'

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 'sess-001',
    path: 'cam-front',
    protocol: 'rtsp',
    exp: Date.now() + 60_000,
    recordedAt: Date.now(),
    ...overrides,
  }
}

describe('SessionRegistry', () => {
  let registry: SessionRegistry

  beforeEach(() => {
    registry = new SessionRegistry()
  })

  describe('add / get', () => {
    it('stores entry and retrieves by id', () => {
      const entry = makeEntry()
      registry.add(entry)
      expect(registry.get('sess-001')).toEqual(entry)
    })

    it('overwrites on duplicate id', () => {
      registry.add(makeEntry({ exp: 1000 }))
      registry.add(makeEntry({ exp: 2000 }))
      expect(registry.get('sess-001')!.exp).toBe(2000)
      expect(registry.size).toBe(1)
    })

    it('returns undefined for unknown id', () => {
      expect(registry.get('nonexistent')).toBeUndefined()
    })
  })

  describe('remove', () => {
    it('deletes existing entry and returns true', () => {
      registry.add(makeEntry())
      expect(registry.remove('sess-001')).toBe(true)
      expect(registry.get('sess-001')).toBeUndefined()
      expect(registry.size).toBe(0)
    })

    it('returns false for unknown id', () => {
      expect(registry.remove('nonexistent')).toBe(false)
    })
  })

  describe('getByPath', () => {
    it('returns all sessions on the same path', () => {
      registry.add(makeEntry({ id: 'a', path: 'cam-front' }))
      registry.add(makeEntry({ id: 'b', path: 'cam-front' }))
      registry.add(makeEntry({ id: 'c', path: 'cam-rear' }))

      const result = registry.getByPath('cam-front')
      expect(result).toHaveLength(2)
      expect(result.map((e) => e.id).sort()).toEqual(['a', 'b'])
    })

    it('returns empty array for unknown path', () => {
      expect(registry.getByPath('nonexistent')).toEqual([])
    })
  })

  describe('entries', () => {
    it('iterates all stored entries', () => {
      registry.add(makeEntry({ id: 'a' }))
      registry.add(makeEntry({ id: 'b' }))

      const ids = [...registry.entries()].map((e) => e.id).sort()
      expect(ids).toEqual(['a', 'b'])
    })

    it('returns empty iterator on empty registry', () => {
      expect([...registry.entries()]).toEqual([])
    })
  })

  describe('size', () => {
    it('reflects add/remove operations', () => {
      expect(registry.size).toBe(0)
      registry.add(makeEntry({ id: 'a' }))
      expect(registry.size).toBe(1)
      registry.add(makeEntry({ id: 'b' }))
      expect(registry.size).toBe(2)
      registry.remove('a')
      expect(registry.size).toBe(1)
    })
  })

  describe('clear', () => {
    it('empties the registry', () => {
      registry.add(makeEntry({ id: 'a' }))
      registry.add(makeEntry({ id: 'b' }))
      registry.clear()
      expect(registry.size).toBe(0)
      expect(registry.get('a')).toBeUndefined()
    })
  })
})
