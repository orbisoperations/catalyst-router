import { describe, it, expect } from 'vitest'
import {
  mapWith,
  mapWithout,
  nestedMapGet,
  nestedMapSet,
  nestedMapDelete,
  nestedMapDeleteOuter,
} from '../../src/v2/map-helpers.js'

describe('mapWith', () => {
  it('returns a new Map with the entry added', () => {
    const original = new Map([['a', 1]])
    const result = mapWith(original, 'b', 2)
    expect(result.get('b')).toBe(2)
    expect(result.get('a')).toBe(1)
    expect(result).not.toBe(original)
    expect(original.has('b')).toBe(false)
  })

  it('returns a new Map with the entry updated', () => {
    const original = new Map([['a', 1]])
    const result = mapWith(original, 'a', 99)
    expect(result.get('a')).toBe(99)
    expect(original.get('a')).toBe(1)
  })
})

describe('mapWithout', () => {
  it('returns a new Map without the entry', () => {
    const original = new Map([
      ['a', 1],
      ['b', 2],
    ])
    const result = mapWithout(original, 'a')
    expect(result.has('a')).toBe(false)
    expect(result.get('b')).toBe(2)
    expect(result).not.toBe(original)
  })

  it('returns same reference when key does not exist', () => {
    const original = new Map([['a', 1]])
    const result = mapWithout(original, 'z')
    expect(result).toBe(original)
  })
})

describe('nestedMapGet', () => {
  it('returns the inner value', () => {
    const inner = new Map([['x', 10]])
    const outer = new Map([['a', inner]])
    expect(nestedMapGet(outer, 'a', 'x')).toBe(10)
  })

  it('returns undefined for missing outer key', () => {
    const outer = new Map<string, Map<string, number>>()
    expect(nestedMapGet(outer, 'a', 'x')).toBeUndefined()
  })

  it('returns undefined for missing inner key', () => {
    const inner = new Map<string, number>()
    const outer = new Map([['a', inner]])
    expect(nestedMapGet(outer, 'a', 'x')).toBeUndefined()
  })
})

describe('nestedMapSet', () => {
  it('sets a value in a new nested Map', () => {
    const outer = new Map<string, Map<string, number>>()
    const result = nestedMapSet(outer, 'a', 'x', 10)
    expect(nestedMapGet(result, 'a', 'x')).toBe(10)
    expect(result).not.toBe(outer)
    expect(outer.size).toBe(0)
  })

  it('creates inner Map if outer key is missing', () => {
    const outer = new Map<string, Map<string, number>>()
    const result = nestedMapSet(outer, 'a', 'x', 10)
    expect(result.get('a')?.size).toBe(1)
  })

  it('preserves existing inner entries', () => {
    const inner = new Map([['x', 10]])
    const outer = new Map([['a', inner]])
    const result = nestedMapSet(outer, 'a', 'y', 20)
    expect(nestedMapGet(result, 'a', 'x')).toBe(10)
    expect(nestedMapGet(result, 'a', 'y')).toBe(20)
  })
})

describe('nestedMapDelete', () => {
  it('removes inner entry and returns new Maps', () => {
    const inner = new Map([
      ['x', 10],
      ['y', 20],
    ])
    const outer = new Map([['a', inner]])
    const result = nestedMapDelete(outer, 'a', 'x')
    expect(nestedMapGet(result, 'a', 'x')).toBeUndefined()
    expect(nestedMapGet(result, 'a', 'y')).toBe(20)
    expect(result).not.toBe(outer)
  })

  it('removes empty inner Map after last entry deleted', () => {
    const inner = new Map([['x', 10]])
    const outer = new Map([['a', inner]])
    const result = nestedMapDelete(outer, 'a', 'x')
    expect(result.has('a')).toBe(false)
  })

  it('returns same reference when outer key is missing', () => {
    const outer = new Map<string, Map<string, number>>()
    const result = nestedMapDelete(outer, 'a', 'x')
    expect(result).toBe(outer)
  })

  it('returns same reference when inner key is missing', () => {
    const inner = new Map([['x', 10]])
    const outer = new Map([['a', inner]])
    const result = nestedMapDelete(outer, 'a', 'nonexistent')
    expect(result).toBe(outer)
  })
})

describe('nestedMapDeleteOuter', () => {
  it('removes entire outer key', () => {
    const inner = new Map([['x', 10]])
    const outer = new Map([
      ['a', inner],
      ['b', new Map([['y', 20]])],
    ])
    const result = nestedMapDeleteOuter(outer, 'a')
    expect(result.has('a')).toBe(false)
    expect(result.has('b')).toBe(true)
  })

  it('returns same reference when outer key does not exist', () => {
    const outer = new Map([['a', new Map([['x', 10]])]])
    const result = nestedMapDeleteOuter(outer, 'z')
    expect(result).toBe(outer)
  })
})
