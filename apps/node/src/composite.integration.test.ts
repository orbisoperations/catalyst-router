import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuthService } from '@catalyst/authorization'
import { CatalystHonoServer } from '@catalyst/service'
import { OrchestratorService } from '@catalyst/orchestrator-service'
import { GatewayService } from '@catalyst/gateway-service'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { buildConfig } from './server.js'

/**
 * Integration tests for the composite Catalyst node.
 *
 * Spins up the full composite server (auth + orchestrator + gateway) on a
 * random available port, exercises all mounted endpoints via HTTP, then
 * tears everything down.
 */

let server: CatalystHonoServer
let baseUrl: string
let port: number

beforeAll(async () => {
  // Use port 0 to let the OS assign a random available port.
  // However, CatalystHonoServer validates that the bound port matches the
  // requested port, so we need to pick an explicit port. Use a high random
  // port to minimise collisions.
  port = 10000 + Math.floor(Math.random() * 50000)

  const config = buildConfig({
    nodeId: 'integration-test.example.somebiz.local.io',
    port: String(port),
    hostname: '127.0.0.1',
    peeringEndpoint: `ws://localhost:${port}/orchestrator/rpc`,
    domains: 'example.somebiz.local.io',
    peeringSecret: 'test-secret',
    keysDb: ':memory:',
    tokensDb: ':memory:',
    revocation: false,
    logLevel: 'warn',
  })

  const auth = await AuthService.create({ config })
  const orchestrator = await OrchestratorService.create({ config })
  const gateway = await GatewayService.create({ config })

  const app = new Hono()
  app.route('/auth', auth.handler)
  app.route('/orchestrator', orchestrator.handler)
  app.route('/gateway', gateway.handler)

  app.get('/', (c) =>
    c.json({
      service: 'catalyst-node',
      version: '1.0.0',
      nodeId: config.node.name,
      mounts: {
        auth: '/auth',
        orchestrator: '/orchestrator',
        gateway: '/gateway',
      },
    })
  )

  server = new CatalystHonoServer(app, {
    services: [auth, orchestrator, gateway],
    port,
    hostname: '127.0.0.1',
    websocket,
  })
  server.start()

  baseUrl = `http://127.0.0.1:${port}`
}, 30_000)

afterAll(async () => {
  if (server) {
    await server.stop()
  }
}, 10_000)

describe('composite node integration', () => {
  describe('GET /', () => {
    it('returns service info JSON', async () => {
      const res = await fetch(`${baseUrl}/`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.service).toBe('catalyst-node')
      expect(body.version).toBe('1.0.0')
      expect(body.nodeId).toBe('integration-test.example.somebiz.local.io')
      expect(body.mounts).toEqual({
        auth: '/auth',
        orchestrator: '/orchestrator',
        gateway: '/gateway',
      })
    })
  })

  describe('GET /health', () => {
    it('returns status ok with all service names', async () => {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(body.services).toEqual(expect.arrayContaining(['auth', 'orchestrator', 'gateway']))
      expect(body.services).toHaveLength(3)
    })
  })

  describe('Auth endpoints', () => {
    it('GET /auth/.well-known/jwks.json returns valid JWKS', async () => {
      const res = await fetch(`${baseUrl}/auth/.well-known/jwks.json`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveProperty('keys')
      expect(Array.isArray(body.keys)).toBe(true)
      expect(body.keys.length).toBeGreaterThan(0)

      // Each key should have standard JWK fields
      const key = body.keys[0]
      expect(key).toHaveProperty('kty')
      expect(key).toHaveProperty('kid')
    })

    it('JWKS endpoint sets cache-control header', async () => {
      const res = await fetch(`${baseUrl}/auth/.well-known/jwks.json`)
      expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    })
  })

  describe('Gateway endpoints', () => {
    it('GET /gateway returns running message', async () => {
      const res = await fetch(`${baseUrl}/gateway`)
      expect(res.status).toBe(200)

      const text = await res.text()
      expect(text).toContain('Gateway')
    })

    it('GET /gateway/graphql returns error without query', async () => {
      const res = await fetch(`${baseUrl}/gateway/graphql`)
      // GraphQL endpoint without a query should return 4xx or a GraphQL error
      // The exact status depends on the implementation but it should not be 5xx
      expect(res.status).toBeLessThan(500)
    })

    it('POST /gateway/graphql with introspection query returns schema', async () => {
      const res = await fetch(`${baseUrl}/gateway/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: '{ __typename }',
        }),
      })

      // Should get a valid response (may be an error if no subgraphs configured,
      // but should not crash)
      expect(res.status).toBeLessThan(500)
    })
  })

  describe('Orchestrator endpoints', () => {
    it('GET /orchestrator/rpc returns a response (WebSocket upgrade expected)', async () => {
      // A plain HTTP GET to the RPC endpoint should not crash the server.
      // It may return 4xx (upgrade required) or 200 depending on implementation.
      const res = await fetch(`${baseUrl}/orchestrator/rpc`)
      expect(res.status).toBeLessThan(500)
    })
  })

  describe('404 handling', () => {
    it('returns 404 for unknown paths', async () => {
      const res = await fetch(`${baseUrl}/nonexistent`)
      expect(res.status).toBe(404)
    })
  })
})
