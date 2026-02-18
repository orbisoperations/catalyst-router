import { describe, it, expect } from 'vitest'
import {
  SignCSRRequestSchema,
  DenyIdentityRequestSchema,
  AllowIdentityRequestSchema,
} from '../src/types.js'

describe('SignCSRRequestSchema', () => {
  it('should accept valid input', () => {
    const result = SignCSRRequestSchema.safeParse({
      csrPem: '-----BEGIN CERTIFICATE REQUEST-----\nMOCK\n-----END CERTIFICATE REQUEST-----',
      serviceType: 'orchestrator',
      instanceId: 'node-a',
    })
    expect(result.success).toBe(true)
  })

  it('should accept with optional ttlSeconds', () => {
    const result = SignCSRRequestSchema.safeParse({
      csrPem: 'mock-csr',
      serviceType: 'node',
      instanceId: 'inst-1',
      ttlSeconds: 3600,
    })
    expect(result.success).toBe(true)
  })

  it('should accept all valid service types', () => {
    for (const svc of ['orchestrator', 'auth', 'node', 'gateway', 'envoy/app', 'envoy/transport']) {
      const result = SignCSRRequestSchema.safeParse({
        csrPem: 'mock',
        serviceType: svc,
        instanceId: 'inst',
      })
      expect(result.success).toBe(true)
    }
  })

  it('should reject missing csrPem', () => {
    const result = SignCSRRequestSchema.safeParse({
      serviceType: 'node',
      instanceId: 'inst',
    })
    expect(result.success).toBe(false)
  })

  it('should reject empty csrPem', () => {
    const result = SignCSRRequestSchema.safeParse({
      csrPem: '',
      serviceType: 'node',
      instanceId: 'inst',
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid serviceType', () => {
    const result = SignCSRRequestSchema.safeParse({
      csrPem: 'mock',
      serviceType: 'invalid',
      instanceId: 'inst',
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing instanceId', () => {
    const result = SignCSRRequestSchema.safeParse({
      csrPem: 'mock',
      serviceType: 'node',
    })
    expect(result.success).toBe(false)
  })

  it('should reject negative ttlSeconds', () => {
    const result = SignCSRRequestSchema.safeParse({
      csrPem: 'mock',
      serviceType: 'node',
      instanceId: 'inst',
      ttlSeconds: -1,
    })
    expect(result.success).toBe(false)
  })
})

describe('DenyIdentityRequestSchema', () => {
  it('should accept valid input', () => {
    const result = DenyIdentityRequestSchema.safeParse({
      spiffeId: 'spiffe://example.com/node/bad',
      reason: 'compromised',
    })
    expect(result.success).toBe(true)
  })

  it('should require spiffe:// prefix', () => {
    const result = DenyIdentityRequestSchema.safeParse({
      spiffeId: 'https://example.com/node/bad',
      reason: 'compromised',
    })
    expect(result.success).toBe(false)
  })

  it('should reject empty reason', () => {
    const result = DenyIdentityRequestSchema.safeParse({
      spiffeId: 'spiffe://example.com/node/bad',
      reason: '',
    })
    expect(result.success).toBe(false)
  })
})

describe('AllowIdentityRequestSchema', () => {
  it('should accept valid input', () => {
    const result = AllowIdentityRequestSchema.safeParse({
      spiffeId: 'spiffe://example.com/node/restored',
    })
    expect(result.success).toBe(true)
  })

  it('should require spiffe:// prefix', () => {
    const result = AllowIdentityRequestSchema.safeParse({
      spiffeId: 'not-spiffe://example.com/node/a',
    })
    expect(result.success).toBe(false)
  })
})
