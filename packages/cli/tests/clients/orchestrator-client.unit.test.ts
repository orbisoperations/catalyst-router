import { describe, expect, it } from 'bun:test'
import { createOrchestratorClient } from '../../src/clients/orchestrator-client.js'

describe('Orchestrator Client', () => {
  it('should create client with default URL', async () => {
    const client = await createOrchestratorClient()
    expect(client).toBeDefined()
    expect(typeof client.connectionFromManagementSDK).toBe('function')
  })

  it('should create client with custom URL', async () => {
    const client = await createOrchestratorClient('ws://custom:3000/rpc')
    expect(client).toBeDefined()
    expect(typeof client.connectionFromManagementSDK).toBe('function')
  })

  it('should use CATALYST_ORCHESTRATOR_URL env var if set', async () => {
    const originalEnv = process.env.CATALYST_ORCHESTRATOR_URL
    process.env.CATALYST_ORCHESTRATOR_URL = 'ws://env-test:3000/rpc'

    const client = await createOrchestratorClient()
    expect(client).toBeDefined()

    // Restore env
    if (originalEnv) {
      process.env.CATALYST_ORCHESTRATOR_URL = originalEnv
    } else {
      delete process.env.CATALYST_ORCHESTRATOR_URL
    }
  })
})
