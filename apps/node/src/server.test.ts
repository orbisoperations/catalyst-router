import { describe, expect, it, vi } from 'vitest'

// Mock Bun-specific imports that fail in Node.js vitest
vi.mock('hono/bun', () => ({
  websocket: {},
  upgradeWebSocket: () => () => new Response(),
}))
vi.mock('@catalyst/authorization', () => ({ AuthService: class {} }))
vi.mock('@catalyst/orchestrator-service', () => ({ OrchestratorService: class {} }))
vi.mock('@catalyst/gateway-service', () => ({ GatewayService: class {} }))
vi.mock('@catalyst/service', () => ({ catalystHonoServer: () => ({ start: () => {} }) }))

import { buildConfig, type CompositeServerOptions } from './server.js'

function defaultOpts(overrides: Partial<CompositeServerOptions> = {}): CompositeServerOptions {
  return {
    nodeId: 'test-node.example.somebiz.local.io',
    port: '3001',
    hostname: '0.0.0.0',
    peeringEndpoint: 'ws://localhost:3001/orchestrator/rpc',
    peeringSecret: 'test-secret',
    keysDb: ':memory:',
    tokensDb: ':memory:',
    revocation: false,
    logLevel: 'info',
    ...overrides,
  }
}

describe('buildConfig', () => {
  it('maps CLI options to CatalystConfig', () => {
    const config = buildConfig(defaultOpts())

    expect(config.port).toBe(3001)
    expect(config.node.name).toBe('test-node.example.somebiz.local.io')
    expect(config.node.endpoint).toBe('ws://localhost:3001/orchestrator/rpc')
    expect(config.node.domains).toEqual([])
    expect(config.auth?.keysDb).toBe(':memory:')
    expect(config.auth?.tokensDb).toBe(':memory:')
    expect(config.orchestrator?.ibgp?.secret).toBe('test-secret')
  })

  it('parses comma-separated domains', () => {
    const config = buildConfig(defaultOpts({ domains: 'foo.com, bar.com , baz.com' }))

    expect(config.node.domains).toEqual(['foo.com', 'bar.com', 'baz.com'])
  })

  it('leaves domains empty when not provided', () => {
    const config = buildConfig(defaultOpts({ domains: undefined }))
    expect(config.node.domains).toEqual([])
  })

  it('auto-wires gateway endpoint from port when not overridden', () => {
    const config = buildConfig(defaultOpts({ port: '4000' }))

    expect(config.orchestrator?.gqlGatewayConfig?.endpoint).toBe('ws://localhost:4000/gateway/api')
  })

  it('uses explicit gateway endpoint when provided', () => {
    const config = buildConfig(defaultOpts({ gatewayEndpoint: 'ws://custom:9000/gw' }))

    expect(config.orchestrator?.gqlGatewayConfig?.endpoint).toBe('ws://custom:9000/gw')
  })

  it('sets revocation config when enabled', () => {
    const config = buildConfig(defaultOpts({ revocation: true, revocationMaxSize: '5000' }))

    expect(config.auth?.revocation?.enabled).toBe(true)
    expect(config.auth?.revocation?.maxSize).toBe(5000)
  })

  it('sets bootstrap config when provided', () => {
    const config = buildConfig(
      defaultOpts({
        bootstrapToken: 'my-bootstrap-token',
        bootstrapTtl: '3600000',
      })
    )

    expect(config.auth?.bootstrap?.token).toBe('my-bootstrap-token')
    expect(config.auth?.bootstrap?.ttl).toBe(3600000)
  })

  it('omits orchestrator auth config (composite mode)', () => {
    const config = buildConfig(defaultOpts())

    // In composite mode, orchestrator.auth is not set — token validation is permissive
    expect(config.orchestrator?.auth).toBeUndefined()
  })
})
