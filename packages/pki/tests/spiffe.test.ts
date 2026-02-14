import { describe, it, expect } from 'bun:test'
import { parseSpiffeId, buildSpiffeId, isValidSpiffeId } from '../src/spiffe.js'

describe('parseSpiffeId', () => {
  it('should parse a regular service type', () => {
    const result = parseSpiffeId('spiffe://example.com/orchestrator/node-a')
    expect(result).toEqual({
      uri: 'spiffe://example.com/orchestrator/node-a',
      trustDomain: 'example.com',
      serviceType: 'orchestrator',
      instanceId: 'node-a',
    })
  })

  it('should parse all regular service types', () => {
    for (const svc of ['orchestrator', 'auth', 'node', 'gateway'] as const) {
      const result = parseSpiffeId(`spiffe://mesh.local/${svc}/inst-1`)
      expect(result.serviceType).toBe(svc)
      expect(result.instanceId).toBe('inst-1')
      expect(result.trustDomain).toBe('mesh.local')
    }
  })

  it('should parse envoy/app service type', () => {
    const result = parseSpiffeId('spiffe://example.com/envoy/app/proxy-1')
    expect(result).toEqual({
      uri: 'spiffe://example.com/envoy/app/proxy-1',
      trustDomain: 'example.com',
      serviceType: 'envoy/app',
      instanceId: 'proxy-1',
    })
  })

  it('should parse envoy/transport service type', () => {
    const result = parseSpiffeId('spiffe://example.com/envoy/transport/proxy-2')
    expect(result).toEqual({
      uri: 'spiffe://example.com/envoy/transport/proxy-2',
      trustDomain: 'example.com',
      serviceType: 'envoy/transport',
      instanceId: 'proxy-2',
    })
  })

  it('should handle instance IDs with slashes', () => {
    const result = parseSpiffeId('spiffe://example.com/node/region/az-1/inst')
    expect(result.serviceType).toBe('node')
    expect(result.instanceId).toBe('region/az-1/inst')
  })

  it('should throw for missing spiffe:// scheme', () => {
    expect(() => parseSpiffeId('https://example.com/node/a')).toThrow('must start with spiffe://')
  })

  it('should throw for empty string', () => {
    expect(() => parseSpiffeId('')).toThrow('must start with spiffe://')
  })

  it('should throw for missing path component', () => {
    expect(() => parseSpiffeId('spiffe://example.com')).toThrow('missing path component')
  })

  it('should throw for empty trust domain', () => {
    expect(() => parseSpiffeId('spiffe:///node/a')).toThrow('empty trust domain')
  })

  it('should throw for missing instance ID', () => {
    expect(() => parseSpiffeId('spiffe://example.com/node')).toThrow('missing instance ID')
  })

  it('should throw for unknown service type', () => {
    expect(() => parseSpiffeId('spiffe://example.com/unknown/a')).toThrow('unknown service type')
  })

  it('should throw for unknown envoy sub-type', () => {
    expect(() => parseSpiffeId('spiffe://example.com/envoy/invalid/a')).toThrow(
      'unknown service type'
    )
  })
})

describe('buildSpiffeId', () => {
  it('should build a regular SPIFFE URI', () => {
    const uri = buildSpiffeId('example.com', 'orchestrator', 'node-a')
    expect(uri).toBe('spiffe://example.com/orchestrator/node-a')
  })

  it('should build an envoy SPIFFE URI', () => {
    const uri = buildSpiffeId('mesh.local', 'envoy/app', 'proxy-1')
    expect(uri).toBe('spiffe://mesh.local/envoy/app/proxy-1')
  })

  it('should throw for empty trust domain', () => {
    expect(() => buildSpiffeId('', 'node', 'a')).toThrow('Trust domain must not be empty')
  })

  it('should throw for empty instance ID', () => {
    expect(() => buildSpiffeId('example.com', 'node', '')).toThrow('Instance ID must not be empty')
  })

  it('should throw for invalid service type', () => {
    // @ts-expect-error testing invalid input
    expect(() => buildSpiffeId('example.com', 'invalid', 'a')).toThrow('Invalid service type')
  })

  it('should round-trip with parseSpiffeId', () => {
    const uri = buildSpiffeId('example.com', 'gateway', 'gw-1')
    const parsed = parseSpiffeId(uri)
    expect(parsed.trustDomain).toBe('example.com')
    expect(parsed.serviceType).toBe('gateway')
    expect(parsed.instanceId).toBe('gw-1')
  })
})

describe('isValidSpiffeId', () => {
  it('should return true for valid SPIFFE IDs', () => {
    expect(isValidSpiffeId('spiffe://example.com/node/a')).toBe(true)
    expect(isValidSpiffeId('spiffe://mesh.local/envoy/app/proxy-1')).toBe(true)
  })

  it('should return false for invalid SPIFFE IDs', () => {
    expect(isValidSpiffeId('')).toBe(false)
    expect(isValidSpiffeId('https://example.com/node/a')).toBe(false)
    expect(isValidSpiffeId('spiffe://example.com')).toBe(false)
    expect(isValidSpiffeId('spiffe://example.com/unknown/a')).toBe(false)
  })
})
