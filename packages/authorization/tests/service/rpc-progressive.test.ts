import { describe, it, expect, beforeAll } from 'bun:test'
import { AuthRpcServer } from '../../src/service/rpc/server.js'
import {
  type TokenHandlers,
  type CertHandlers,
  type ValidationHandlers,
} from '../../src/service/rpc/schema.js'
import {
  ALL_POLICIES,
  AuthorizationEngine,
  CATALYST_SCHEMA,
  type CatalystPolicyDomain,
} from '../../src/policy/src/index.js'
import { JWTTokenFactory } from '../../src/jwt/jwt-token-factory.js'
import { Principal } from '../../src/policy/src/definitions/models.js'
import type { TokenRecord } from '../../src/jwt/index.js'
import { TelemetryBuilder } from '@catalyst/telemetry'

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

    it('should deny access to token handlers with non-admin token', async () => {
      const result = await rpcServer.tokens(userToken)
      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('ADMIN role required')
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

  describe('Isolation Boundaries', () => {
    it('should deny access if domain mismatch', async () => {
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

      const result = await rpcServer.tokens(otherDomainToken)
      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('ADMIN role required')
    })

    it('should deny access if node mismatch (when trustedNodes is set)', async () => {
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
      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('ADMIN role required')
    })

    it('should grant access if node matches (when trustedNodes is set)', async () => {
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

      const handlers = await rpcServer.tokens(matchedNodeToken)
      expect(handlers).not.toHaveProperty('error')
    })

    it('should grant access across multiple trusted domains', async () => {
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

      const handlers = await rpcServer.tokens(multiDomainToken)
      expect(handlers).not.toHaveProperty('error')
    })
  })
})
