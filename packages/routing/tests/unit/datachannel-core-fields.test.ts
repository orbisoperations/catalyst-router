import { describe, it, expect } from 'bun:test'
import { DataChannelDefinitionSchema } from '../../src/datachannel.js'

describe('DataChannelDefinitionSchema > core fields', () => {
  it('accepts minimal definition with required name and protocol', () => {
    const result = DataChannelDefinitionSchema.safeParse({
      name: 'test-service',
      protocol: 'http',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe('test-service')
      expect(result.data.protocol).toBe('http')
    }
  })

  it('accepts all optional fields (endpoint, region, tags)', () => {
    const result = DataChannelDefinitionSchema.safeParse({
      name: 'graphql-service',
      protocol: 'http:graphql',
      endpoint: 'http://localhost:8080/graphql',
      region: 'us-east-1',
      tags: ['production', 'web'],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.endpoint).toBe('http://localhost:8080/graphql')
      expect(result.data.region).toBe('us-east-1')
      expect(result.data.tags).toEqual(['production', 'web'])
    }
  })

  it('accepts all valid protocol types (http, http:graphql, http:gql, http:grpc, tcp)', () => {
    for (const protocol of ['http', 'http:graphql', 'http:gql', 'http:grpc', 'tcp']) {
      const result = DataChannelDefinitionSchema.safeParse({
        name: 'test',
        protocol,
      })
      expect(result.success).toBe(true)
    }
  })

  it('rejects unsupported protocol type', () => {
    const result = DataChannelDefinitionSchema.safeParse({
      name: 'test',
      protocol: 'ftp',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid endpoint URL', () => {
    const result = DataChannelDefinitionSchema.safeParse({
      name: 'test',
      protocol: 'http',
      endpoint: 'not-a-url',
    })
    expect(result.success).toBe(false)
  })
})
