import { describe, it, expect } from 'vitest'
import {
  routeKey,
  DataChannelProtocolEnum,
  DataChannelDefinitionSchema,
} from '../../src/v2/datachannel.js'

describe('routeKey', () => {
  it('returns route name', () => {
    expect(routeKey({ name: 'my-service' })).toBe('my-service')
  })
})

describe('DataChannelProtocolEnum', () => {
  it('includes media as a valid protocol', () => {
    expect(DataChannelProtocolEnum.safeParse('media').success).toBe(true)
  })
})

describe('DataChannelDefinitionSchema', () => {
  it('accepts a media protocol route', () => {
    const result = DataChannelDefinitionSchema.safeParse({
      name: 'cam-front',
      protocol: 'media',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a route with metadata', () => {
    const result = DataChannelDefinitionSchema.safeParse({
      name: 'cam-front',
      protocol: 'media',
      metadata: { sourceNode: 'node-a', sourceType: 'rtsp' },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.metadata).toEqual({ sourceNode: 'node-a', sourceType: 'rtsp' })
    }
  })

  it('accepts a route without metadata', () => {
    const result = DataChannelDefinitionSchema.safeParse({
      name: 'api',
      protocol: 'http',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.metadata).toBeUndefined()
    }
  })
})
