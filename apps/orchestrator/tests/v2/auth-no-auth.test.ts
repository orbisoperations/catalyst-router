import { describe, it, expect, vi } from 'vitest'
import { buildTokenValidator } from '../../src/v2/catalyst-service.js'

describe('buildTokenValidator', () => {
  it('without auth client and no allowNoAuth, returns invalid', async () => {
    const validator = buildTokenValidator({
      authClient: undefined,
      allowNoAuth: false,
      config: { node: { name: 'test-node', domains: ['test.local'] } },
      logger: { warn: vi.fn(), error: vi.fn() },
    })

    const result = await validator.validateToken('any-token', 'PEER_CREATE')

    expect(result).toEqual({ valid: false, error: 'Auth not configured' })
  })

  it('with allowNoAuth: true and no auth client, returns valid', async () => {
    const validator = buildTokenValidator({
      authClient: undefined,
      allowNoAuth: true,
      config: { node: { name: 'test-node', domains: ['test.local'] } },
      logger: { warn: vi.fn(), error: vi.fn() },
    })

    const result = await validator.validateToken('any-token', 'PEER_CREATE')

    expect(result).toEqual({ valid: true })
  })

  it('with auth client present, allowNoAuth is ignored and normal validation runs', async () => {
    const mockPermissionsApi = {
      authorizeAction: vi.fn().mockResolvedValue({ success: true, allowed: true }),
    }
    const mockAuthClient = {
      permissions: vi.fn().mockResolvedValue(mockPermissionsApi),
    }

    const validator = buildTokenValidator({
      authClient: mockAuthClient as never,
      allowNoAuth: true,
      config: { node: { name: 'test-node', domains: ['test.local'] } },
      logger: { warn: vi.fn(), error: vi.fn() },
    })

    const result = await validator.validateToken('real-token', 'PEER_CREATE')

    expect(result).toEqual({ valid: true })
    expect(mockAuthClient.permissions).toHaveBeenCalledWith('real-token')
    expect(mockPermissionsApi.authorizeAction).toHaveBeenCalledWith({
      action: 'PEER_CREATE',
      nodeContext: { nodeId: 'test-node', domains: ['test.local'] },
    })
  })

  it('with auth client that denies, returns invalid regardless of allowNoAuth', async () => {
    const mockPermissionsApi = {
      authorizeAction: vi.fn().mockResolvedValue({ success: true, allowed: false }),
    }
    const mockAuthClient = {
      permissions: vi.fn().mockResolvedValue(mockPermissionsApi),
    }

    const validator = buildTokenValidator({
      authClient: mockAuthClient as never,
      allowNoAuth: true,
      config: { node: { name: 'test-node', domains: ['test.local'] } },
      logger: { warn: vi.fn(), error: vi.fn() },
    })

    const result = await validator.validateToken('real-token', 'PEER_CREATE')

    expect(result).toEqual({ valid: false, error: 'Authorization failed' })
  })
})
