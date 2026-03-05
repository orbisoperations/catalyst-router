import { describe, it, expect } from 'vitest'
import { DataChannelDefinitionSchema } from '../src/datachannel.js'

describe('DataChannelDefinitionSchema', () => {
  describe('existing fields (backward compatibility)', () => {
    it('parses a minimal definition with name and protocol', () => {
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

    it('parses with all existing optional fields', () => {
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

    it('parses all valid protocol types', () => {
      for (const protocol of ['http', 'http:graphql', 'http:gql', 'http:grpc', 'tcp']) {
        const result = DataChannelDefinitionSchema.safeParse({
          name: 'test',
          protocol,
        })
        expect(result.success).toBe(true)
      }
    })

    it('rejects invalid protocol', () => {
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

  describe('envoyPort field', () => {
    it('parses without envoyPort (backward compatible)', () => {
      const result = DataChannelDefinitionSchema.safeParse({
        name: 'test-service',
        protocol: 'http',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.envoyPort).toBeUndefined()
      }
    })

    it('parses with valid envoyPort', () => {
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

    it('accepts envoyPort at boundary values', () => {
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

    it('coexists with all other fields', () => {
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
})
