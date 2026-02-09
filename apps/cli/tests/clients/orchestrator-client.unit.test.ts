import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { resolveOrchestratorUrl } from '../../src/clients/orchestrator-client.js'

describe('resolveOrchestratorUrl', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.CATALYST_ORCHESTRATOR_URL
    delete process.env.CATALYST_ORCHESTRATOR_URL
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CATALYST_ORCHESTRATOR_URL = originalEnv
    } else {
      delete process.env.CATALYST_ORCHESTRATOR_URL
    }
  })

  it('should return explicit URL when provided', () => {
    process.env.CATALYST_ORCHESTRATOR_URL = 'ws://from-env:3000/rpc'
    expect(resolveOrchestratorUrl('ws://explicit:3000/rpc')).toBe('ws://explicit:3000/rpc')
  })

  it('should fall back to CATALYST_ORCHESTRATOR_URL env var', () => {
    process.env.CATALYST_ORCHESTRATOR_URL = 'ws://from-env:3000/rpc'
    expect(resolveOrchestratorUrl()).toBe('ws://from-env:3000/rpc')
  })

  it('should fall back to default when no URL or env var', () => {
    expect(resolveOrchestratorUrl()).toBe('ws://localhost:3000/rpc')
  })
})
