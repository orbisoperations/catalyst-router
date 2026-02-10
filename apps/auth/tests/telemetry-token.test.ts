import { describe, it, expect, beforeAll } from 'bun:test'
import * as jose from 'jose'

describe('Telemetry Token', () => {
  let app: { fetch: (req: Request) => Promise<Response> }
  let sysToken: string

  beforeAll(async () => {
    process.env.CATALYST_AUTH_KEYS_DB = ':memory:'
    process.env.CATALYST_AUTH_TOKENS_DB = ':memory:'
    process.env.CATALYST_NODE_ID = 'test-node'
    process.env.CATALYST_PEERING_ENDPOINT = 'http://localhost:3000'
    process.env.CATALYST_AUTH_ISSUER = 'http://auth:4020'

    const { startServer } = await import('../src/server.js')
    const result = await startServer()
    app = result.app
    sysToken = result.systemToken!
  })

  describe('GET /.well-known/openid-configuration', () => {
    it('should return OIDC discovery document with correct issuer', async () => {
      const res = await app.fetch(new Request('http://localhost/.well-known/openid-configuration'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.issuer).toBe('http://auth:4020')
      expect(body.jwks_uri).toBe('http://auth:4020/.well-known/jwks.json')
      expect(body.id_token_signing_alg_values_supported).toEqual(['ES384'])
    })

    it('should not require authentication', async () => {
      const res = await app.fetch(new Request('http://localhost/.well-known/openid-configuration'))
      expect(res.status).toBe(200)
    })
  })

  describe('GET /telemetry/token', () => {
    it('should return telemetry JWT with correct claims when authenticated', async () => {
      const res = await app.fetch(
        new Request('http://localhost/telemetry/token', {
          headers: { Authorization: `Bearer ${sysToken}` },
        })
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.token).toBeDefined()
      expect(body.expiresAt).toBeDefined()

      // Verify JWT claims
      const decoded = jose.decodeJwt(body.token)
      expect(decoded.iss).toBe('http://auth:4020')
      expect(decoded.sub).toBe('telemetry-exporter')
      expect(decoded.aud).toBe('otel-collector')
      expect(decoded.roles).toEqual(['TELEMETRY_EXPORTER'])
      expect(decoded.entity).toMatchObject({
        id: 'telemetry-exporter',
        name: 'Telemetry Exporter',
        type: 'service',
        role: 'TELEMETRY_EXPORTER',
      })
    })

    it('should return 401 without authorization header', async () => {
      const res = await app.fetch(new Request('http://localhost/telemetry/token'))
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Invalid or missing authorization token')
    })

    it('should return cached token on subsequent calls', async () => {
      const res1 = await app.fetch(
        new Request('http://localhost/telemetry/token', {
          headers: { Authorization: `Bearer ${sysToken}` },
        })
      )
      const body1 = await res1.json()

      const res2 = await app.fetch(
        new Request('http://localhost/telemetry/token', {
          headers: { Authorization: `Bearer ${sysToken}` },
        })
      )
      const body2 = await res2.json()

      expect(body1.token).toBe(body2.token)
    })
  })
})
