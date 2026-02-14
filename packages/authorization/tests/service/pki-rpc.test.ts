import { describe, it, expect, beforeAll } from 'bun:test'
import * as x509 from '@peculiar/x509'
import { AuthRpcServer } from '../../src/service/rpc/server.js'
import type { PkiHandlers } from '../../src/service/rpc/schema.js'
import {
  ALL_POLICIES,
  AuthorizationEngine,
  CATALYST_SCHEMA,
  type CatalystPolicyDomain,
} from '../../src/policy/src/index.js'
import { JWTTokenFactory } from '../../src/jwt/jwt-token-factory.js'
import { Principal } from '../../src/policy/src/definitions/models.js'
import { TelemetryBuilder } from '@catalyst/telemetry'
import { CertificateManager } from '@catalyst/pki'

// Ensure @peculiar/x509 uses Bun's crypto
x509.cryptoProvider.set(crypto)

const EC_ALGORITHM: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-384' }
const SIGNING_ALGORITHM: EcdsaParams = { name: 'ECDSA', hash: 'SHA-384' }

/**
 * Generate a CSR (PKCS#10) for testing. Returns the PEM string.
 */
async function generateCSR(instanceId: string, spiffeId: string): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(EC_ALGORITHM, true, ['sign', 'verify'])

  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${instanceId}`,
    keys: keyPair,
    signingAlgorithm: SIGNING_ALGORITHM,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'url', value: spiffeId }])],
  })

  return csr.toString('pem')
}

describe('PKI Progressive API', () => {
  let tokenFactory: JWTTokenFactory
  let policyService: AuthorizationEngine<CatalystPolicyDomain>
  let certificateManager: CertificateManager
  let rpcServer: AuthRpcServer
  let rpcServerNoPki: AuthRpcServer
  let adminToken: string
  let userToken: string

  beforeAll(async () => {
    tokenFactory = JWTTokenFactory.ephemeral({ nodeId: 'test-node' })
    await tokenFactory.initialize()

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

    // CertificateManager: ephemeral in-memory for testing
    certificateManager = CertificateManager.ephemeral({ trustDomain: 'test.example.com' })
    await certificateManager.initialize()

    // RPC Server WITH PKI
    rpcServer = new AuthRpcServer(
      tokenFactory,
      TelemetryBuilder.noop('auth-test'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      policyService as any,
      'test-node',
      'test-domain',
      certificateManager
    )

    // RPC Server WITHOUT PKI (no CertificateManager)
    rpcServerNoPki = new AuthRpcServer(
      tokenFactory,
      TelemetryBuilder.noop('auth-test'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      policyService as any,
      'test-node',
      'test-domain'
    )
  })

  describe('access control', () => {
    it('should grant access to PKI handlers with valid admin token', async () => {
      const handlers = await rpcServer.pki(adminToken)
      expect(handlers).not.toHaveProperty('error')
      const pkiHandlers = handlers as PkiHandlers
      expect(pkiHandlers.initialize).toBeDefined()
      expect(pkiHandlers.signCsr).toBeDefined()
      expect(pkiHandlers.getCaBundle).toBeDefined()
      expect(pkiHandlers.getStatus).toBeDefined()
      expect(pkiHandlers.denyIdentity).toBeDefined()
      expect(pkiHandlers.allowIdentity).toBeDefined()
      expect(pkiHandlers.listDenied).toBeDefined()
      expect(pkiHandlers.listCertificates).toBeDefined()
      expect(pkiHandlers.purgeExpired).toBeDefined()
    })

    it('should deny access to PKI handlers with non-admin token', async () => {
      const result = await rpcServer.pki(userToken)
      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('ADMIN principal required')
    })

    it('should deny access to PKI handlers with invalid token', async () => {
      const result = await rpcServer.pki('not-a-valid-jwt')
      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('Invalid token')
    })

    it('should return "PKI not configured" when CertificateManager is not provided', async () => {
      const result = await rpcServerNoPki.pki(adminToken)
      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toBe('PKI not configured')
    })
  })

  describe('initialize', () => {
    it('should return fingerprints on success', async () => {
      const handlers = (await rpcServer.pki(adminToken)) as PkiHandlers
      const result = await handlers.initialize()
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.rootFingerprint).toBeString()
        expect(result.rootFingerprint.length).toBeGreaterThan(0)
        expect(result.servicesCaFingerprint).toBeString()
        expect(result.transportCaFingerprint).toBeString()
      }
    })
  })

  describe('signCsr', () => {
    it('should sign a valid CSR and return cert + chain', async () => {
      const handlers = (await rpcServer.pki(adminToken)) as PkiHandlers

      const instanceId = 'test-orchestrator-1'
      const spiffeId = 'spiffe://test.example.com/orchestrator/test-orchestrator-1'
      const csrPem = await generateCSR(instanceId, spiffeId)

      const result = await handlers.signCsr({
        csrPem,
        serviceType: 'orchestrator',
        instanceId,
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.certificatePem).toContain('BEGIN CERTIFICATE')
        expect(result.chain).toBeArray()
        expect(result.chain.length).toBe(2) // intermediate + root
        expect(result.expiresAt).toBeString()
        expect(result.renewAfter).toBeString()
        expect(result.fingerprint).toBeString()
        expect(result.serial).toBeString()
      }
    })
  })

  describe('getCaBundle', () => {
    it('should return trust bundles', async () => {
      const handlers = (await rpcServer.pki(adminToken)) as PkiHandlers
      const bundle = await handlers.getCaBundle()

      expect(bundle.trustDomain).toBe('test.example.com')
      expect(bundle.servicesBundle).toBeArray()
      expect(bundle.servicesBundle.length).toBeGreaterThan(0)
      expect(bundle.transportBundle).toBeArray()
      expect(bundle.transportBundle.length).toBeGreaterThan(0)
      expect(bundle.version).toBeString()
      expect(bundle.expiresAt).toBeString()
    })
  })

  describe('getStatus', () => {
    it('should return healthy status after initialization', async () => {
      const handlers = (await rpcServer.pki(adminToken)) as PkiHandlers
      const status = await handlers.getStatus()

      expect(status.status).toBe('healthy')
      expect(status.trustDomain).toBe('test.example.com')
      expect(status.rootCa).not.toBeNull()
      expect(status.servicesCa).not.toBeNull()
      expect(status.transportCa).not.toBeNull()
      expect(status.activeCertCount).toBeNumber()
      expect(status.deniedIdentityCount).toBeNumber()
      expect(status.warnings).toBeArray()
    })
  })

  describe('deny and allow identity', () => {
    it('should deny an identity and list it in denied', async () => {
      const handlers = (await rpcServer.pki(adminToken)) as PkiHandlers
      const spiffeId = 'spiffe://test.example.com/node/denied-node-1'

      const denyResult = await handlers.denyIdentity({
        spiffeId,
        reason: 'compromised key material',
      })
      expect(denyResult.success).toBe(true)

      const denied = await handlers.listDenied()
      expect(denied.some((d) => d.spiffeId === spiffeId)).toBe(true)
    })

    it('should re-enable a denied identity via allowIdentity', async () => {
      const handlers = (await rpcServer.pki(adminToken)) as PkiHandlers
      const spiffeId = 'spiffe://test.example.com/node/reallow-node-1'

      // Deny first
      await handlers.denyIdentity({
        spiffeId,
        reason: 'temporary suspension',
      })

      // Then allow
      const allowResult = await handlers.allowIdentity({ spiffeId })
      expect(allowResult.success).toBe(true)

      // Verify no longer in denied list
      const denied = await handlers.listDenied()
      expect(denied.some((d) => d.spiffeId === spiffeId)).toBe(false)
    })
  })

  describe('listCertificates', () => {
    it('should return active certificates', async () => {
      const handlers = (await rpcServer.pki(adminToken)) as PkiHandlers
      const certs = await handlers.listCertificates()

      expect(certs).toBeArray()
      // We signed at least one cert earlier in signCsr test
      // Each entry should have the expected shape
      for (const cert of certs) {
        expect(cert.serial).toBeString()
        expect(cert.fingerprint).toBeString()
        expect(cert.expiresAt).toBeString()
        expect(cert.status).toBeString()
      }
    })
  })

  describe('purgeExpired', () => {
    it('should return purged count', async () => {
      const handlers = (await rpcServer.pki(adminToken)) as PkiHandlers
      const result = await handlers.purgeExpired()

      expect(result).toHaveProperty('purgedCount')
      expect(result.purgedCount).toBeNumber()
      expect(result.purgedCount).toBeGreaterThanOrEqual(0)
    })
  })
})
