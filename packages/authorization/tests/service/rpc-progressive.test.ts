import { TelemetryBuilder } from '@catalyst/telemetry'
import { beforeAll, describe, expect, it } from 'bun:test'
import type { TokenRecord } from '../../src/jwt/index.js'
import { JWTTokenFactory } from '../../src/jwt/jwt-token-factory.js'
import { Principal } from '../../src/policy/src/definitions/models.js'
import {
  ALL_POLICIES,
  AuthorizationEngine,
  CATALYST_SCHEMA,
  type CatalystPolicyDomain,
} from '../../src/policy/src/index.js'
import {
  type CertHandlers,
  type TokenHandlers,
  type ValidationHandlers,
} from '../../src/service/rpc/schema.js'
import { AuthRpcServer } from '../../src/service/rpc/server.js'

describe('Auth Progressive API', () => {
  let tokenFactory: JWTTokenFactory
  let policyService: AuthorizationEngine<CatalystPolicyDomain>
  let rpcServer: AuthRpcServer
  let adminToken: string
  let userToken: string

  beforeAll(async () => {
    tokenFactory = JWTTokenFactory.ephemeral({ nodeId: 'test-node' })
    await tokenFactory.initialize()

    // Sign tokens for testing
    // Admin token: Trusted for 'test-domain'
    adminToken = await tokenFactory.mint({
      subject: 'admin-user',
      entity: {
        id: 'admin-user',
        name: 'Admin',
        type: 'user',
        trustedDomains: ['test-domain'],
      },
      principal: Principal.ADMIN,
    })

    // User token: Trusted for 'test-domain'
    userToken = await tokenFactory.mint({
      subject: 'regular-user',
      entity: {
        id: 'regular-user',
        name: 'User',
        type: 'user',
        trustedDomains: ['test-domain'],
      },
      principal: Principal.USER,
    })

    policyService = new AuthorizationEngine<CatalystPolicyDomain>(CATALYST_SCHEMA, ALL_POLICIES)

    // RPC Server: Belongs to 'test-node' and 'test-domain'
    rpcServer = new AuthRpcServer(
      tokenFactory,
      TelemetryBuilder.noop('auth-test'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      policyService as any,
      'test-node',
      'test-domain'
    )
  })

  describe('tokens sub-api', () => {
    it('should grant access to token handlers with valid admin token', async () => {
      const handlers = await rpcServer.tokens(adminToken)
      expect(handlers).not.toHaveProperty('error')
      const tokenHandlers = handlers as TokenHandlers
      expect(tokenHandlers.create).toBeDefined()
      expect(tokenHandlers.revoke).toBeDefined()
      expect(tokenHandlers.list).toBeDefined()
    })

    it('should deny per-operation access with non-admin token', async () => {
      // tokens() now returns handlers for any valid token; authz is per-handler
      const result = await rpcServer.tokens(userToken)
      expect(result).not.toHaveProperty('error')
      const handlers = result as TokenHandlers

      // But calling create should fail with permission denied
      expect(
        handlers.create({
          subject: 'test',
          entity: { id: 't1', name: 'Test', type: 'user' },
          principal: Principal.NODE,
        })
      ).rejects.toThrow()
    })

    it('should allow creating and revoking a token via token handlers', async () => {
      const handlers = (await rpcServer.tokens(adminToken)) as TokenHandlers
      const newToken = await handlers.create({
        subject: 'new-service',
        entity: { id: 's1', name: 'Service', type: 'service' },
        principal: Principal.NODE,
      })
      expect(newToken).toBeString()

      // List and find it
      const tokens = await handlers.list({})
      expect(tokens.some((t: TokenRecord) => t.entityId === 's1')).toBe(true)

      // Revoke it
      const jti = tokens.find((t: TokenRecord) => t.entityId === 's1')!.jti
      await handlers.revoke({ jti })

      // Verify it is revoked
      const validation = (await rpcServer.validation(adminToken)) as ValidationHandlers
      const verifyResult = (await validation.validate({ token: newToken })) as {
        valid: false
        error: string
      }
      expect(verifyResult.valid).toBe(false)
      expect(verifyResult.error).toContain('revoked')
    })
  })

  describe('certs sub-api', () => {
    it('should grant access to cert handlers with valid admin token', async () => {
      const handlers = await rpcServer.certs(adminToken)
      expect(handlers).not.toHaveProperty('error')
      const certHandlers = handlers as CertHandlers
      expect(certHandlers.list).toBeDefined()
      expect(certHandlers.rotate).toBeDefined()
    })

    it('should allow rotating keys via cert handlers', async () => {
      const handlers = (await rpcServer.certs(adminToken)) as CertHandlers
      const result = (await handlers.rotate({ immediate: false })) as {
        success: true
        newKeyId: string
      }
      expect(result.success).toBe(true)
      expect(result.newKeyId).toBeString()
    })
  })

  describe('validation sub-api', () => {
    it('should grant access to validation handlers with any valid token', async () => {
      const result = await rpcServer.validation(userToken)
      expect(result).not.toHaveProperty('error')
      const handlers = result as ValidationHandlers
      expect(handlers.validate).toBeDefined()
      expect(handlers.getJWKS).toBeDefined()
      expect(handlers.getRevocationList).toBeDefined()
    })

    it('should allow validating a token via validation handlers', async () => {
      const handlers = (await rpcServer.validation(adminToken)) as ValidationHandlers
      const validationResult = (await handlers.validate({ token: userToken })) as {
        valid: true
        payload: Record<string, unknown>
      }
      expect(validationResult.valid).toBe(true)
      expect(validationResult.payload.sub).toBe('regular-user')
    })

    it('should return revocation list', async () => {
      const handlers = (await rpcServer.validation(adminToken)) as ValidationHandlers
      const crl = await handlers.getRevocationList()
      expect(Array.isArray(crl)).toBe(true)
    })
  })

  describe('authenticate (authentication-only)', () => {
    it('should return valid=true with payload for a valid token', async () => {
      const result = await rpcServer.authenticate(adminToken)
      expect(result.valid).toBe(true)
      if (result.valid) {
        expect(result.payload).toBeDefined()
        expect(result.payload.sub).toBe('admin-user')
        expect(result.payload.principal).toBe(Principal.ADMIN)
      }
    })

    it('should return valid=true for a user token (no policy check)', async () => {
      const result = await rpcServer.authenticate(userToken)
      expect(result.valid).toBe(true)
      if (result.valid) {
        expect(result.payload).toBeDefined()
        expect(result.payload.sub).toBe('regular-user')
        expect(result.payload.principal).toBe(Principal.USER)
      }
    })

    it('should return valid=false for an invalid token', async () => {
      const result = await rpcServer.authenticate('invalid-token-string')
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toBeDefined()
      }
    })

    it('should return valid=false for a revoked token', async () => {
      // Create and then revoke a token
      const handlers = (await rpcServer.tokens(adminToken)) as TokenHandlers
      const tempToken = await handlers.create({
        subject: 'temp-user',
        entity: { id: 'temp1', name: 'Temp', type: 'user' },
        principal: Principal.USER,
      })

      // Verify it authenticates before revocation
      const beforeRevoke = await rpcServer.authenticate(tempToken)
      expect(beforeRevoke.valid).toBe(true)

      // Revoke it
      const tokens = await handlers.list({})
      const jti = tokens.find((t: TokenRecord) => t.entityId === 'temp1')!.jti
      await handlers.revoke({ jti })

      // Now authenticate should fail
      const afterRevoke = await rpcServer.authenticate(tempToken)
      expect(afterRevoke.valid).toBe(false)
    })

    it('should NOT evaluate Cedar policies (any principal can authenticate)', async () => {
      // A user with no special permissions should still authenticate successfully
      // This proves authenticate does NOT check Cedar policies
      const limitedToken = await tokenFactory.mint({
        subject: 'limited-user',
        entity: {
          id: 'limited-user',
          name: 'Limited',
          type: 'user',
          trustedDomains: ['other-domain'], // Different domain
        },
        principal: Principal.USER,
      })

      const result = await rpcServer.authenticate(limitedToken)
      expect(result.valid).toBe(true)
      // If this were going through Cedar, a domain mismatch would fail
      // authenticate() only checks JWT validity
    })
  })

  describe('permissions sub-api (authorization)', () => {
    it('should authorize an action for admin principal', async () => {
      const permissionsApi = await rpcServer.permissions(adminToken)
      expect(permissionsApi).not.toHaveProperty('error')
      if (!('error' in permissionsApi)) {
        const result = await permissionsApi.authorizeAction({
          action: 'PEER_CREATE',
          nodeContext: { nodeId: 'test-node', domains: ['test-domain'] },
        })
        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.allowed).toBe(true)
        }
      }
    })

    it('should deny an action for user principal on admin-only operations', async () => {
      const permissionsApi = await rpcServer.permissions(userToken)
      expect(permissionsApi).not.toHaveProperty('error')
      if (!('error' in permissionsApi)) {
        const result = await permissionsApi.authorizeAction({
          action: 'PEER_CREATE',
          nodeContext: { nodeId: 'test-node', domains: ['test-domain'] },
        })
        // USER should not be able to create peers - either denied or system error
        if (result.success) {
          expect(result.allowed).toBe(false)
        } else {
          // Cedar may return permission_denied or system_error depending on schema
          expect(['permission_denied', 'system_error']).toContain(result.errorType)
        }
      }
    })
  })

  describe('Isolation Boundaries', () => {
    it('should deny per-op access if domain mismatch', async () => {
      // Token for 'other-domain'
      const otherDomainToken = await tokenFactory.mint({
        subject: 'admin-user',
        entity: {
          id: 'admin-user',
          name: 'Admin',
          type: 'user',
          trustedDomains: ['other-domain'],
        },
        principal: Principal.ADMIN,
      })

      // tokens() returns handlers for any valid token
      const result = await rpcServer.tokens(otherDomainToken)
      expect(result).not.toHaveProperty('error')
      const handlers = result as TokenHandlers

      // But per-op check should fail due to domain mismatch
      await expect(
        handlers.create({
          subject: 'test',
          entity: { id: 't1', name: 'Test', type: 'user' },
          principal: Principal.NODE,
        })
      ).rejects.toThrow()
    })

    it('should deny per-op access if node mismatch (when trustedNodes is set)', async () => {
      // Token restricted to 'other-node'
      const otherNodeToken = await tokenFactory.mint({
        subject: 'admin-user',
        entity: {
          id: 'admin-user',
          name: 'Admin',
          type: 'user',
          trustedDomains: ['test-domain'],
          trustedNodes: ['other-node'],
        },
        principal: Principal.ADMIN,
      })

      const result = await rpcServer.tokens(otherNodeToken)
      expect(result).not.toHaveProperty('error')
      const handlers = result as TokenHandlers

      // Per-op check should fail due to node mismatch
      await expect(handlers.list({})).rejects.toThrow()
    })

    it('should grant per-op access if node matches (when trustedNodes is set)', async () => {
      // Token restricted to 'test-node'
      const matchedNodeToken = await tokenFactory.mint({
        subject: 'admin-user',
        entity: {
          id: 'admin-user',
          name: 'Admin',
          type: 'user',
          trustedDomains: ['test-domain'],
          trustedNodes: ['test-node'],
        },
        principal: Principal.ADMIN,
      })

      const handlers = (await rpcServer.tokens(matchedNodeToken)) as TokenHandlers
      // Should succeed since node matches
      const tokens = await handlers.list({})
      expect(Array.isArray(tokens)).toBe(true)
    })

    it('should grant per-op access across multiple trusted domains', async () => {
      // Token trusted for both A and B
      const multiDomainToken = await tokenFactory.mint({
        subject: 'admin-user',
        entity: {
          id: 'admin-user',
          name: 'Admin',
          type: 'user',
          trustedDomains: ['domain-A', 'test-domain'],
        },
        principal: Principal.ADMIN,
      })

      const handlers = (await rpcServer.tokens(multiDomainToken)) as TokenHandlers
      // Should succeed since test-domain is in trustedDomains
      const tokens = await handlers.list({})
      expect(Array.isArray(tokens)).toBe(true)
    })
  })
})
