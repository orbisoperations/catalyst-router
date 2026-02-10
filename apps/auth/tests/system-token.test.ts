import { beforeAll, describe, expect, it } from 'bun:test'
import * as jose from 'jose'

describe('System Admin Token', () => {
  let systemToken: string

  beforeAll(async () => {
    // Use in-memory databases for tests
    process.env.CATALYST_AUTH_KEYS_DB = ':memory:'
    process.env.CATALYST_AUTH_TOKENS_DB = ':memory:'
    process.env.CATALYST_NODE_ID = 'test-node'
    process.env.CATALYST_PEERING_ENDPOINT = 'http://localhost:3000'

    // Import and start server to trigger minting
    const { startServer } = await import('../src/server.js')
    const result = await startServer()
    systemToken = result.systemToken!
  })

  it('should be minted and available after startup', () => {
    expect(systemToken).toBeDefined()
    expect(typeof systemToken).toBe('string')
    expect(systemToken.length).toBeGreaterThan(10)
  })

  it('should contain expected administrative claims', () => {
    const payload = jose.decodeJwt(systemToken) as jose.JWTPayload & {
      principal: string
      entity: { id: string; type: string }
    }
    expect(payload).toBeDefined()

    expect(payload.sub).toBe('bootstrap')
    expect(payload.principal).toBe('CATALYST::ADMIN')
    expect(payload.entity?.id).toBe('system')
    expect(payload.entity?.type).toBe('service')
  })
})
