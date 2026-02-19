import { describe, expect, it } from 'bun:test'
import { ConnectionPool } from '../src/orchestrator.js'

function endpointFor(type: 'http' | 'ws'): string {
  return type === 'ws' ? 'ws://127.0.0.1:65530/rpc' : 'http://127.0.0.1:65530/rpc'
}

describe('ConnectionPool', () => {
  for (const type of ['http', 'ws'] as const) {
    it(`reuses cached stubs for Envoy calls (${type})`, () => {
      const pool = new ConnectionPool(type)
      const endpoint = endpointFor(type)

      const first = pool.getEnvoy(endpoint)
      const second = pool.getEnvoy(endpoint)

      expect(second).toBe(first)
    })

    it(`reuses cached stubs for Gateway calls (${type})`, () => {
      const pool = new ConnectionPool(type)
      const endpoint = endpointFor(type)

      const first = pool.getGateway(endpoint)
      const second = pool.getGateway(endpoint)

      expect(second).toBe(first)
    })

    it(`shares cache across get/getEnvoy/getGateway (${type})`, () => {
      const pool = new ConnectionPool(type)
      const endpoint = endpointFor(type)

      const peerStub = pool.get(endpoint)
      const envoyStub = pool.getEnvoy(endpoint)
      const gatewayStub = pool.getGateway(endpoint)

      expect(envoyStub).toBe(peerStub)
      expect(gatewayStub).toBe(peerStub)
    })
  }
})
