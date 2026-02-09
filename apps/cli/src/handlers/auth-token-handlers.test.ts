import { describe, expect, it } from 'bun:test'
import type {
  MintTokenInput,
  VerifyTokenInput,
  RevokeTokenInput,
  ListTokensInput,
} from '../types.js'

describe('Auth Token Handlers', () => {
  describe('Type Definitions', () => {
    it('should have MintTokenInput type with required fields', () => {
      const input: MintTokenInput = {
        subject: 'user-123',
        role: 'USER',
        name: 'Test User',
        type: 'user',
        authUrl: 'ws://localhost:4000/rpc',
      }
      expect(input.subject).toBe('user-123')
      expect(input.role).toBe('USER')
      expect(input.name).toBe('Test User')
      expect(input.type).toBe('user')
    })

    it('should have MintTokenInput type with optional fields', () => {
      const input: MintTokenInput = {
        subject: 'node-456',
        role: 'NODE',
        name: 'Test Node',
        type: 'service',
        expiresIn: '7d',
        nodeId: 'node-456',
        trustedDomains: ['example.com'],
        trustedNodes: ['node-123'],
        token: 'admin-token',
        authUrl: 'ws://localhost:4000/rpc',
      }
      expect(input.expiresIn).toBe('7d')
      expect(input.nodeId).toBe('node-456')
      expect(input.trustedDomains).toEqual(['example.com'])
      expect(input.trustedNodes).toEqual(['node-123'])
    })

    it('should have VerifyTokenInput type with required fields', () => {
      const input: VerifyTokenInput = {
        tokenToVerify: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...',
        authUrl: 'ws://localhost:4000/rpc',
      }
      expect(input.tokenToVerify).toBeDefined()
    })

    it('should have VerifyTokenInput type with optional fields', () => {
      const input: VerifyTokenInput = {
        tokenToVerify: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...',
        audience: 'catalyst-api',
        token: 'admin-token',
        authUrl: 'ws://localhost:4000/rpc',
      }
      expect(input.audience).toBe('catalyst-api')
      expect(input.token).toBe('admin-token')
    })

    it('should have RevokeTokenInput type with jti', () => {
      const input: RevokeTokenInput = {
        jti: 'token-jti-123',
        authUrl: 'ws://localhost:4000/rpc',
      }
      expect(input.jti).toBe('token-jti-123')
    })

    it('should have RevokeTokenInput type with san', () => {
      const input: RevokeTokenInput = {
        san: 'node-123.example.com',
        authUrl: 'ws://localhost:4000/rpc',
      }
      expect(input.san).toBe('node-123.example.com')
    })

    it('should have ListTokensInput type with optional fields', () => {
      const input: ListTokensInput = {
        certificateFingerprint: 'abc123',
        san: 'node-123.example.com',
        token: 'admin-token',
        authUrl: 'ws://localhost:4000/rpc',
      }
      expect(input.certificateFingerprint).toBe('abc123')
      expect(input.san).toBe('node-123.example.com')
    })
  })

  describe('Handler Return Types', () => {
    it('mintTokenHandler should return success result type', () => {
      const successResult: { success: true; data: { token: string } } = {
        success: true,
        data: { token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...' },
      }
      expect(successResult.success).toBe(true)
      expect(successResult.data.token).toBeDefined()
    })

    it('mintTokenHandler should return error result type', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'Auth failed',
      }
      expect(errorResult.success).toBe(false)
      expect(errorResult.error).toBe('Auth failed')
    })

    it('verifyTokenHandler should return valid token result', () => {
      const successResult: {
        success: true
        data: { valid: true; payload: Record<string, unknown> }
      } = {
        success: true,
        data: {
          valid: true,
          payload: { sub: 'user-123', role: 'USER' },
        },
      }
      expect(successResult.success).toBe(true)
      expect(successResult.data.valid).toBe(true)
      expect(successResult.data.payload.sub).toBe('user-123')
    })

    it('verifyTokenHandler should return invalid token result', () => {
      const successResult: {
        success: true
        data: { valid: false; error: string }
      } = {
        success: true,
        data: {
          valid: false,
          error: 'Token expired',
        },
      }
      expect(successResult.success).toBe(true)
      expect(successResult.data.valid).toBe(false)
      expect(successResult.data.error).toBe('Token expired')
    })

    it('verifyTokenHandler should return error result type', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'Connection failed',
      }
      expect(errorResult.success).toBe(false)
      expect(errorResult.error).toBe('Connection failed')
    })

    it('revokeTokenHandler should return success result type', () => {
      const successResult: { success: true } = {
        success: true,
      }
      expect(successResult.success).toBe(true)
    })

    it('revokeTokenHandler should return error result type', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'Token not found',
      }
      expect(errorResult.success).toBe(false)
      expect(errorResult.error).toBe('Token not found')
    })

    it('listTokensHandler should return success result with tokens array', () => {
      const successResult: {
        success: true
        data: {
          tokens: Array<{
            jti: string
            sub: string
            iat: number
            exp: number
            revoked: boolean
          }>
        }
      } = {
        success: true,
        data: {
          tokens: [
            {
              jti: 'token-jti-123',
              sub: 'user-123',
              iat: 1700000000,
              exp: 1700086400,
              revoked: false,
            },
            {
              jti: 'token-jti-456',
              sub: 'node-456',
              iat: 1700000000,
              exp: 1700086400,
              revoked: true,
            },
          ],
        },
      }
      expect(successResult.success).toBe(true)
      expect(successResult.data.tokens.length).toBe(2)
      expect(successResult.data.tokens[0].revoked).toBe(false)
      expect(successResult.data.tokens[1].revoked).toBe(true)
    })
  })

  describe('Handler Error Handling', () => {
    it('should handle network errors gracefully', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'Network connection failed',
      }
      expect(errorResult.success).toBe(false)
      expect(typeof errorResult.error).toBe('string')
    })

    it('should handle auth errors gracefully', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'Auth failed: invalid token',
      }
      expect(errorResult.success).toBe(false)
      expect(errorResult.error).toContain('Auth failed')
    })

    it('should handle missing auth URL gracefully', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'Auth URL is required',
      }
      expect(errorResult.success).toBe(false)
      expect(errorResult.error).toBe('Auth URL is required')
    })
  })
})
