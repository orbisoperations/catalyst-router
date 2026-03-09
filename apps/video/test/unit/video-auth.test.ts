import { describe, expect, it, vi } from 'vitest'
import { Action } from '@catalyst/authorization'
import { createVideoAuthService } from '../../src/video-auth.js'

const nodeContext = {
  nodeId: 'node-a.somebiz.local.io',
  domains: ['somebiz.local.io'],
}

describe('createVideoAuthService', () => {
  it('fails closed when auth service is not configured', async () => {
    const auth = createVideoAuthService({})

    const result = await auth.evaluate({
      token: 'viewer-token',
      action: Action.STREAM_DISCOVER,
      nodeContext,
    })

    expect(result).toEqual({
      success: false,
      errorType: 'auth_unavailable',
      reason: 'Auth not configured',
    })
  })

  it('returns invalid_token when permissions API rejects the token', async () => {
    const auth = createVideoAuthService({
      authClient: {
        permissions: vi.fn(async () => ({ error: 'Invalid token' })),
      },
    })

    const result = await auth.evaluate({
      token: 'bad-token',
      action: Action.STREAM_SUBSCRIBE,
      nodeContext,
      resource: { routeName: 'node-a/cam-front', protocol: 'media' },
    })

    expect(result).toEqual({
      success: false,
      errorType: 'invalid_token',
      reason: 'Invalid token',
    })
  })

  it('delegates action checks to auth permissions API', async () => {
    const authorizeAction = vi.fn(async () => ({ success: true as const, allowed: true as const }))
    const permissions = vi.fn(async () => ({ authorizeAction }))
    const auth = createVideoAuthService({
      authClient: { permissions },
    })

    const result = await auth.evaluate({
      token: 'viewer-token',
      action: Action.STREAM_DISCOVER,
      nodeContext,
    })

    expect(result).toEqual({ success: true, allowed: true })
    expect(permissions).toHaveBeenCalledWith('viewer-token')
    expect(authorizeAction).toHaveBeenCalledWith({
      action: Action.STREAM_DISCOVER,
      nodeContext,
    })
  })

  it('propagates permission denials from the auth service', async () => {
    const auth = createVideoAuthService({
      authClient: {
        permissions: vi.fn(async () => ({
          authorizeAction: vi.fn(async () => ({
            success: false as const,
            errorType: 'permission_denied',
            reasons: ['forbidden'],
          })),
        })),
      },
    })

    const result = await auth.evaluate({
      token: 'viewer-token',
      action: Action.STREAM_SUBSCRIBE,
      nodeContext,
      resource: { routeName: 'node-a/cam-front', protocol: 'media' },
    })

    expect(result).toEqual({
      success: false,
      errorType: 'permission_denied',
      reasons: ['forbidden'],
    })
  })

  // T022: expired token -> fail-closed behavior
  it('returns auth_unavailable when authClient.permissions() throws (expired token)', async () => {
    const auth = createVideoAuthService({
      authClient: {
        permissions: vi.fn(async () => {
          throw new Error('Token expired')
        }),
      },
    })

    const result = await auth.evaluate({
      token: 'expired-token',
      action: Action.STREAM_SUBSCRIBE,
      nodeContext,
      resource: { routeName: 'node-a/cam-front', protocol: 'media' },
    })

    expect(result).toEqual({
      success: false,
      errorType: 'auth_unavailable',
      reason: 'Authorization failed',
    })
  })
})
