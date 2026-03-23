import { describe, it, expect } from 'vitest'
import { routeKey } from '../../src/v2/datachannel.js'

describe('routeKey', () => {
  it('returns route name', () => {
    expect(routeKey({ name: 'my-service' })).toBe('my-service')
  })
})
