import { describe, expect, it } from 'vitest'
import * as jose from 'jose'
import { type TokenStore } from '../../src/jwt/index.js'
import { LocalTokenManager } from '../../src/jwt/local/index.js'
import { type IKeyManager } from '../../src/key-manager/index.js'
import { Principal } from '../../src/policy/src/definitions/models.js'

describe('LocalTokenManager', () => {
  const mockKeyManager: IKeyManager = {
    sign: async (options: {
      subject: string
      claims?: Record<string, unknown>
      expiresAt?: number
    }) => {
      // Create a dummy JWT for testing
      const payload = {
        sub: options.subject,
        jti: 'test-jti',
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...options.claims,
      }
      return new jose.SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256' })
        .sign(new TextEncoder().encode('secret'))
    },
    verify: async () => ({ valid: true, payload: {} }),
    getJwks: async () => ({ keys: [] }),
    rotate: async () => ({ previousKeyId: '', newKeyId: '' }),
    getCurrentKeyId: async () => 'test-kid',
    shutdown: async () => {},
    initialize: async () => {},
    isInitialized: () => true,
  }

  const mockStore: TokenStore = {
    recordToken: async () => {},
    findToken: async () => null,
    revokeToken: async () => {},
    revokeBySan: async () => {},
    isRevoked: async () => false,
    getRevocationList: async () => [],
    listTokens: async () => [],
  }

  it('should auto-inject nodeId if configured', async () => {
    const manager = new LocalTokenManager(mockKeyManager, mockStore, 'node-a')

    const token = await manager.mint({
      subject: 'user-1',
      principal: Principal.USER,
      entity: {
        id: 'user-1',
        name: 'alice',
        type: 'user',
      },
    })

    const decoded = jose.decodeJwt(token)
    const entity = decoded.entity as Record<string, unknown>
    expect(entity.nodeId).toBe('node-a')
  })

  it('should not overwrite nodeId if explicitly provided', async () => {
    const manager = new LocalTokenManager(mockKeyManager, mockStore, 'node-a')

    const token = await manager.mint({
      subject: 'user-1',
      principal: Principal.USER,
      entity: {
        id: 'user-1',
        name: 'alice',
        type: 'user',
        nodeId: 'node-b', // Explicitly provided
      },
    })

    const decoded = jose.decodeJwt(token)
    const entity = decoded.entity as Record<string, unknown>
    expect(entity.nodeId).toBe('node-b')
  })
})
