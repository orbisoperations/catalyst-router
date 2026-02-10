import { describe, expect, it } from 'bun:test'
import { createAuthClient } from '../../src/clients/auth-client.js'

describe('Auth Client', () => {
  it('should create client with default URL', async () => {
    const client = await createAuthClient()
    expect(client).toBeDefined()
    expect(typeof client.tokens).toBe('function')
    expect(typeof client.validation).toBe('function')
  })

  it('should create client with custom URL', async () => {
    const client = await createAuthClient('ws://custom:4000/rpc')
    expect(client).toBeDefined()
    expect(typeof client.tokens).toBe('function')
    expect(typeof client.validation).toBe('function')
  })

  it('should use CATALYST_AUTH_URL env var if set', async () => {
    const originalEnv = process.env.CATALYST_AUTH_URL
    process.env.CATALYST_AUTH_URL = 'ws://env-test:4000/rpc'

    const client = await createAuthClient()
    expect(client).toBeDefined()

    // Restore env
    if (originalEnv) {
      process.env.CATALYST_AUTH_URL = originalEnv
    } else {
      delete process.env.CATALYST_AUTH_URL
    }
  })
})
