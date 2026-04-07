import { describe, it, expect } from 'vitest'
import { comparePaths } from '../../src/v2/best-path.js'
import type { InternalRoute } from '../../src/v2/state.js'

function makeIR(overrides: Partial<InternalRoute> & { peer: { name: string } }): InternalRoute {
  return {
    name: 'svc-x',
    protocol: 'http' as const,
    originNode: 'origin',
    nodePath: ['peer-a'],
    peer: { name: 'peer-a', domains: ['test'] },
    ...overrides,
  }
}

describe('comparePaths', () => {
  it('returns negative when a is preferred over b', () => {
    const a = makeIR({ nodePath: ['p1'], peer: { name: 'p1', domains: ['t'] } })
    const b = makeIR({ nodePath: ['p2', 'p1'], peer: { name: 'p2', domains: ['t'] } })
    expect(comparePaths(a, b)).toBeLessThan(0)
  })

  it('returns positive when b is preferred over a', () => {
    const a = makeIR({ nodePath: ['p2', 'p1'], peer: { name: 'p2', domains: ['t'] } })
    const b = makeIR({ nodePath: ['p1'], peer: { name: 'p1', domains: ['t'] } })
    expect(comparePaths(a, b)).toBeGreaterThan(0)
  })

  it('non-stale beats stale', () => {
    const fresh = makeIR({
      isStale: false,
      nodePath: ['p1', 'p2'],
      peer: { name: 'p1', domains: ['t'] },
    })
    const stale = makeIR({ isStale: true, nodePath: ['p3'], peer: { name: 'p3', domains: ['t'] } })
    expect(comparePaths(fresh, stale)).toBeLessThan(0)
  })

  it('non-draining beats draining', () => {
    const healthy = makeIR({
      draining: false,
      nodePath: ['p1', 'p2'],
      peer: { name: 'p1', domains: ['t'] },
    })
    const draining = makeIR({
      draining: true,
      nodePath: ['p3'],
      peer: { name: 'p3', domains: ['t'] },
    })
    expect(comparePaths(healthy, draining)).toBeLessThan(0)
  })

  it('shorter path wins when stale/drain are equal', () => {
    const short = makeIR({ nodePath: ['p1'], peer: { name: 'p1', domains: ['t'] } })
    const long = makeIR({ nodePath: ['p2', 'p1'], peer: { name: 'p2', domains: ['t'] } })
    expect(comparePaths(short, long)).toBeLessThan(0)
  })

  it('lowest peer name wins as deterministic tiebreaker', () => {
    const a = makeIR({ nodePath: ['alpha'], peer: { name: 'alpha', domains: ['t'] } })
    const b = makeIR({ nodePath: ['bravo'], peer: { name: 'bravo', domains: ['t'] } })
    expect(comparePaths(a, b)).toBeLessThan(0)
  })

  it('returns 0 for identical routes', () => {
    const r = makeIR({ nodePath: ['p1'], peer: { name: 'p1', domains: ['t'] } })
    expect(comparePaths(r, r)).toBe(0)
  })
})
