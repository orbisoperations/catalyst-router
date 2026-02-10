import { describe, it, expect, beforeEach } from 'bun:test'
import * as jose from 'jose'
import { BunSqliteKeyStore, PersistentLocalKeyManager } from '../../src/index.js'

describe('PersistentLocalKeyManager issuer claim', () => {
  let keyStore: BunSqliteKeyStore

  beforeEach(() => {
    keyStore = new BunSqliteKeyStore(':memory:')
  })

  it('should include iss claim when issuer is configured', async () => {
    const manager = new PersistentLocalKeyManager(keyStore, {
      issuer: 'http://auth:4020',
    })
    await manager.initialize()

    const token = await manager.sign({
      subject: 'telemetry-exporter',
      audience: 'otel-collector',
      expiresAt: Date.now() + 3600000,
    })

    const decoded = jose.decodeJwt(token)
    expect(decoded.iss).toBe('http://auth:4020')
    expect(decoded.sub).toBe('telemetry-exporter')
    expect(decoded.aud).toBe('otel-collector')
  })

  it('should omit iss claim when issuer is not configured', async () => {
    const manager = new PersistentLocalKeyManager(keyStore)
    await manager.initialize()

    const token = await manager.sign({
      subject: 'test-subject',
      expiresAt: Date.now() + 3600000,
    })

    const decoded = jose.decodeJwt(token)
    expect(decoded.iss).toBeUndefined()
    expect(decoded.sub).toBe('test-subject')
  })

  it('should verify tokens with issuer claim', async () => {
    const manager = new PersistentLocalKeyManager(keyStore, {
      issuer: 'http://auth:4020',
    })
    await manager.initialize()

    const token = await manager.sign({
      subject: 'telemetry-exporter',
      audience: 'otel-collector',
      expiresAt: Date.now() + 3600000,
    })

    const result = await manager.verify(token, { audience: 'otel-collector' })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.payload.iss).toBe('http://auth:4020')
    }
  })
})
