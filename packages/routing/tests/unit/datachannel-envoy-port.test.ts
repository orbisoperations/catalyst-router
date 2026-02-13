import { describe, it, expect } from 'bun:test'
import { DataChannelDefinitionSchema } from '../../src/datachannel.js'

describe('DataChannelDefinitionSchema > envoyPort field', () => {
  it('defaults envoyPort to undefined when omitted', () => {
    const result = DataChannelDefinitionSchema.safeParse({
      name: 'test-service',
      protocol: 'http',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.envoyPort).toBeUndefined()
    }
  })

  it('accepts valid integer envoyPort', () => {
    const result = DataChannelDefinitionSchema.safeParse({
      name: 'test-service',
      protocol: 'http',
      envoyPort: 9001,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.envoyPort).toBe(9001)
    }
  })

  it('rejects non-integer envoyPort', () => {
    const result = DataChannelDefinitionSchema.safeParse({
      name: 'test-service',
      protocol: 'http',
      envoyPort: 9001.5,
    })
    expect(result.success).toBe(false)
  })

  it('accepts envoyPort at port boundaries (1 and 65535)', () => {
    expect(
      DataChannelDefinitionSchema.safeParse({
        name: 'test',
        protocol: 'http',
        envoyPort: 1,
      }).success
    ).toBe(true)

    expect(
      DataChannelDefinitionSchema.safeParse({
        name: 'test',
        protocol: 'http',
        envoyPort: 65535,
      }).success
    ).toBe(true)
  })

  it('accepts envoyPort alongside all other fields', () => {
    const result = DataChannelDefinitionSchema.safeParse({
      name: 'full-service',
      protocol: 'http:grpc',
      endpoint: 'http://localhost:8080',
      region: 'eu-west-1',
      tags: ['grpc'],
      envoyPort: 9005,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.envoyPort).toBe(9005)
      expect(result.data.endpoint).toBe('http://localhost:8080')
      expect(result.data.region).toBe('eu-west-1')
    }
  })
})
