import { describe, it, expect } from 'bun:test'
import { parseXfcc, validateCertBinding, type XfccIdentity } from '../../src/middleware/xfcc.js'

describe('parseXfcc', () => {
  it('parses Hash field', () => {
    const result = parseXfcc('Hash=abc123def456')
    expect(result).toEqual({ hash: 'abc123def456' })
  })

  it('parses URI field', () => {
    const result = parseXfcc('URI=spiffe://trust.domain/service/instance')
    expect(result).toEqual({ uri: 'spiffe://trust.domain/service/instance' })
  })

  it('parses all fields', () => {
    const result = parseXfcc(
      'Hash=abc123;URI=spiffe://example.com/svc;Subject="CN=svc,O=example";DNS=svc.example.com'
    )
    expect(result).toEqual({
      hash: 'abc123',
      uri: 'spiffe://example.com/svc',
      subject: 'CN=svc,O=example',
      dns: ['svc.example.com'],
    })
  })

  it('handles multiple DNS entries', () => {
    const result = parseXfcc('Hash=abc;DNS=a.example.com;DNS=b.example.com')
    expect(result).toEqual({
      hash: 'abc',
      dns: ['a.example.com', 'b.example.com'],
    })
  })

  it('handles quoted Subject with commas', () => {
    const result = parseXfcc('Hash=abc;Subject="CN=test,O=My Org,C=US"')
    expect(result).toEqual({
      hash: 'abc',
      subject: 'CN=test,O=My Org,C=US',
    })
  })

  it('takes first element from multi-element XFCC (proxy chain)', () => {
    const result = parseXfcc('Hash=first;URI=spiffe://a,Hash=second;URI=spiffe://b')
    expect(result?.hash).toBe('first')
    expect(result?.uri).toBe('spiffe://a')
  })

  it('returns undefined for empty string', () => {
    expect(parseXfcc('')).toBeUndefined()
  })

  it('returns undefined for whitespace-only string', () => {
    expect(parseXfcc('   ')).toBeUndefined()
  })

  it('is case-insensitive for field names', () => {
    const result = parseXfcc('Hash=abc;URI=spiffe://test;Subject="CN=x";DNS=y.com')
    expect(result?.hash).toBe('abc')
    expect(result?.uri).toBe('spiffe://test')
  })
})

describe('validateCertBinding', () => {
  it('returns bound:true when hashes match', () => {
    const jwt = { cnf: { 'x5t#S256': 'abc123' } }
    const xfcc: XfccIdentity = { hash: 'abc123' }
    expect(validateCertBinding(jwt, xfcc)).toEqual({ bound: true })
  })

  it('returns bound:true for case-insensitive match', () => {
    const jwt = { cnf: { 'x5t#S256': 'ABC123' } }
    const xfcc: XfccIdentity = { hash: 'abc123' }
    expect(validateCertBinding(jwt, xfcc)).toEqual({ bound: true })
  })

  it('returns bound:false when hashes mismatch', () => {
    const jwt = { cnf: { 'x5t#S256': 'abc123' } }
    const xfcc: XfccIdentity = { hash: 'def456' }
    const result = validateCertBinding(jwt, xfcc)
    expect(result.bound).toBe(false)
    if (result.bound === false) {
      expect(result.reason).toContain('mismatch')
    }
  })

  it('returns skipped when no XFCC (localhost caller)', () => {
    const jwt = { cnf: { 'x5t#S256': 'abc123' } }
    const result = validateCertBinding(jwt, undefined)
    expect(result.bound).toBe('skipped')
  })

  it('returns skipped when XFCC has no hash', () => {
    const jwt = { cnf: { 'x5t#S256': 'abc123' } }
    const xfcc: XfccIdentity = { uri: 'spiffe://test' }
    const result = validateCertBinding(jwt, xfcc)
    expect(result.bound).toBe('skipped')
  })

  it('returns skipped when JWT has no cnf claim', () => {
    const jwt = { sub: 'user' }
    const xfcc: XfccIdentity = { hash: 'abc123' }
    const result = validateCertBinding(jwt, xfcc)
    expect(result.bound).toBe('skipped')
  })

  it('returns skipped when JWT cnf has no x5t#S256', () => {
    const jwt = { cnf: { jkt: 'some-thumbprint' } }
    const xfcc: XfccIdentity = { hash: 'abc123' }
    const result = validateCertBinding(jwt, xfcc)
    expect(result.bound).toBe('skipped')
  })
})
