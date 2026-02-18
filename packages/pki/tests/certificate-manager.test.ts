import { describe, it, expect, beforeEach } from 'vitest'
import * as x509 from '@peculiar/x509'
import { CertificateManager } from '../src/certificate-manager.js'

// Ensure @peculiar/x509 uses Bun's crypto
x509.cryptoProvider.set(crypto)

const EC_ALGORITHM: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-384' }
const SIGNING_ALGORITHM: EcdsaParams = { name: 'ECDSA', hash: 'SHA-384' }

/**
 * Generate a CSR (PKCS#10) for testing. Returns the PEM and key pair.
 * The CSR includes a SPIFFE URI SAN matching the expected identity.
 */
async function generateCSR(
  spiffeId: string,
  instanceId: string
): Promise<{
  csrPem: string
  keyPair: CryptoKeyPair
}> {
  const keyPair = await crypto.subtle.generateKey(EC_ALGORITHM, true, ['sign', 'verify'])

  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${instanceId}`,
    keys: keyPair,
    signingAlgorithm: SIGNING_ALGORITHM,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'url', value: spiffeId }])],
  })

  return { csrPem: csr.toString('pem'), keyPair }
}

describe('CertificateManager', () => {
  let manager: CertificateManager

  beforeEach(async () => {
    manager = CertificateManager.ephemeral({ trustDomain: 'test.example.com' })
  })

  // ===== Lifecycle =====

  describe('lifecycle', () => {
    it('should report uninitialized before initialize()', () => {
      expect(manager.isInitialized()).toBe(false)
    })

    it('should report initialized after initialize()', async () => {
      await manager.initialize()
      expect(manager.isInitialized()).toBe(true)
    })

    it('should return fingerprints for all 3 CAs on initialize', async () => {
      const result = await manager.initialize()
      expect(result.rootFingerprint).toBeTypeOf('string')
      expect(result.rootFingerprint.length).toBeGreaterThan(0)
      expect(result.servicesCaFingerprint).toBeTypeOf('string')
      expect(result.servicesCaFingerprint.length).toBeGreaterThan(0)
      expect(result.transportCaFingerprint).toBeTypeOf('string')
      expect(result.transportCaFingerprint.length).toBeGreaterThan(0)
    })

    it('should be idempotent — second call loads existing CAs', async () => {
      const first = await manager.initialize()
      const second = await manager.initialize()

      // Same fingerprints — no new keys generated
      expect(second.rootFingerprint).toBe(first.rootFingerprint)
      expect(second.servicesCaFingerprint).toBe(first.servicesCaFingerprint)
      expect(second.transportCaFingerprint).toBe(first.transportCaFingerprint)
    })

    it('should create root CA + services CA + transport CA in the store', async () => {
      await manager.initialize()
      const store = manager.getStore()

      const root = await store.loadCaCertificate('root-ca')
      const services = await store.loadCaCertificate('services-ca')
      const transport = await store.loadCaCertificate('transport-ca')

      expect(root).not.toBeNull()
      expect(root!.commonName).toBe('Catalyst Root CA')
      expect(root!.issuerSerial).toBeNull() // self-signed
      expect(root!.privateKeyPem).not.toBeNull()

      expect(services).not.toBeNull()
      expect(services!.commonName).toBe('Catalyst Services CA')
      expect(services!.issuerSerial).toBe(root!.serial)
      expect(services!.privateKeyPem).not.toBeNull()

      expect(transport).not.toBeNull()
      expect(transport!.commonName).toBe('Catalyst Transport CA')
      expect(transport!.issuerSerial).toBe(root!.serial)
      expect(transport!.privateKeyPem).not.toBeNull()
    })

    it('should generate valid X.509 certificates in the CA hierarchy', async () => {
      await manager.initialize()
      const store = manager.getStore()

      const root = await store.loadCaCertificate('root-ca')
      const rootCert = new x509.X509Certificate(root!.certificatePem)

      // Root is self-signed
      expect(rootCert.subject).toBe('CN=Catalyst Root CA')
      expect(rootCert.issuer).toBe('CN=Catalyst Root CA')

      const services = await store.loadCaCertificate('services-ca')
      const servicesCert = new x509.X509Certificate(services!.certificatePem)

      // Services CA signed by root
      expect(servicesCert.subject).toBe('CN=Catalyst Services CA')
      expect(servicesCert.issuer).toBe('CN=Catalyst Root CA')
    })

    it('should call shutdown without error', async () => {
      await manager.initialize()
      await manager.shutdown()
    })

    it('should call shutdown without initialization', async () => {
      await manager.shutdown()
    })
  })

  // ===== CSR Signing =====

  describe('signCSR', () => {
    beforeEach(async () => {
      await manager.initialize()
    })

    it('should produce valid end-entity cert for orchestrator', async () => {
      const spiffeId = 'spiffe://test.example.com/orchestrator/orch-1'
      const { csrPem } = await generateCSR(spiffeId, 'orch-1')

      const result = await manager.signCSR({
        csrPem,
        serviceType: 'orchestrator',
        instanceId: 'orch-1',
      })

      expect(result.certificatePem).toContain('BEGIN CERTIFICATE')
      expect(result.chain).toHaveLength(2) // services CA + root CA
      expect(result.serial).toBeTypeOf('string')
      expect(result.fingerprint).toBeTypeOf('string')
      expect(result.expiresAt).toBeTypeOf('string')
      expect(result.renewAfter).toBeTypeOf('string')

      // Verify the cert itself
      const cert = new x509.X509Certificate(result.certificatePem)
      expect(cert.subject).toBe('CN=orch-1')

      // Verify SPIFFE URI SAN
      const sanExt = cert.getExtension(x509.SubjectAlternativeNameExtension)
      expect(sanExt).not.toBeNull()
      const uriNames = sanExt!.names.items.filter((n: x509.GeneralName) => n.type === 'url')
      expect(uriNames).toHaveLength(1)
      expect(uriNames[0].value).toBe(spiffeId)
    })

    it('should use default TTL of 1 hour', async () => {
      const { csrPem } = await generateCSR('spiffe://test.example.com/node/n1', 'n1')

      const result = await manager.signCSR({
        csrPem,
        serviceType: 'node',
        instanceId: 'n1',
      })

      const cert = new x509.X509Certificate(result.certificatePem)
      const duration = cert.notAfter.getTime() - cert.notBefore.getTime()
      // Default is 1 hour (3600s) = 3_600_000ms
      expect(duration).toBe(3_600_000)
    })

    it('should cap TTL at maxSvidTtlSeconds', async () => {
      const shortManager = CertificateManager.ephemeral({
        trustDomain: 'test.example.com',
        maxSvidTtlSeconds: 1800, // 30 min cap
      })
      await shortManager.initialize()

      const { csrPem } = await generateCSR('spiffe://test.example.com/node/n1', 'n1')

      const result = await shortManager.signCSR({
        csrPem,
        serviceType: 'node',
        instanceId: 'n1',
        ttlSeconds: 7200, // request 2 hours
      })

      const cert = new x509.X509Certificate(result.certificatePem)
      const duration = cert.notAfter.getTime() - cert.notBefore.getTime()
      // Should be capped at 30 min
      expect(duration).toBe(1_800_000)
    })

    it('should compute renewAfter from notBefore + 50% of TTL', async () => {
      const { csrPem } = await generateCSR('spiffe://test.example.com/node/n1', 'n1')

      const result = await manager.signCSR({
        csrPem,
        serviceType: 'node',
        instanceId: 'n1',
      })

      const cert = new x509.X509Certificate(result.certificatePem)
      const notBefore = cert.notBefore.getTime()
      const notAfter = cert.notAfter.getTime()
      const ttl = notAfter - notBefore

      const renewAfter = new Date(result.renewAfter).getTime()
      // renewAfter should be notBefore + 50% of TTL
      // X.509 dates are truncated to seconds so allow 2s tolerance
      const expected = notBefore + ttl / 2
      expect(Math.abs(renewAfter - expected)).toBeLessThan(2000)
    })

    it('should produce gateway cert with serverAuth only', async () => {
      const { csrPem } = await generateCSR('spiffe://test.example.com/gateway/gw-1', 'gw-1')

      const result = await manager.signCSR({
        csrPem,
        serviceType: 'gateway',
        instanceId: 'gw-1',
      })

      const cert = new x509.X509Certificate(result.certificatePem)
      const ekuExt = cert.getExtension(x509.ExtendedKeyUsageExtension)
      expect(ekuExt).not.toBeNull()

      // Gateway should have serverAuth only, NOT clientAuth
      expect(ekuExt!.usages).toContain(x509.ExtendedKeyUsage.serverAuth)
      expect(ekuExt!.usages).not.toContain(x509.ExtendedKeyUsage.clientAuth)
    })

    it('should sign envoy cert with transport CA (not services CA)', async () => {
      const { csrPem } = await generateCSR('spiffe://test.example.com/envoy/app/proxy-1', 'proxy-1')

      const result = await manager.signCSR({
        csrPem,
        serviceType: 'envoy/app',
        instanceId: 'proxy-1',
      })

      // The chain[0] should be the transport CA, not services CA
      const issuingCa = new x509.X509Certificate(result.chain[0])
      expect(issuingCa.subject).toBe('CN=Catalyst Transport CA')
    })

    it('should sign orchestrator cert with services CA', async () => {
      const { csrPem } = await generateCSR(
        'spiffe://test.example.com/orchestrator/orch-1',
        'orch-1'
      )

      const result = await manager.signCSR({
        csrPem,
        serviceType: 'orchestrator',
        instanceId: 'orch-1',
      })

      const issuingCa = new x509.X509Certificate(result.chain[0])
      expect(issuingCa.subject).toBe('CN=Catalyst Services CA')
    })

    it('should store the end-entity cert in the store', async () => {
      const { csrPem } = await generateCSR('spiffe://test.example.com/node/n1', 'n1')

      const result = await manager.signCSR({
        csrPem,
        serviceType: 'node',
        instanceId: 'n1',
      })

      const stored = await manager.getStore().findBySerial(result.serial)
      expect(stored).not.toBeNull()
      expect(stored!.type).toBe('end-entity')
      expect(stored!.spiffeId).toBe('spiffe://test.example.com/node/n1')
      expect(stored!.fingerprint).toBe(result.fingerprint)
    })

    it('should reject signing when identity is denied', async () => {
      const spiffeId = 'spiffe://test.example.com/node/bad-node'
      await manager.denyIdentity(spiffeId, 'compromised')

      const { csrPem } = await generateCSR(spiffeId, 'bad-node')

      expect(
        manager.signCSR({
          csrPem,
          serviceType: 'node',
          instanceId: 'bad-node',
        })
      ).rejects.toThrow('Identity denied')
    })

    it('should throw if CA not initialized', async () => {
      const uninitManager = CertificateManager.ephemeral({
        trustDomain: 'test.example.com',
      })

      const { csrPem } = await generateCSR('spiffe://test.example.com/node/n1', 'n1')

      expect(
        uninitManager.signCSR({
          csrPem,
          serviceType: 'node',
          instanceId: 'n1',
        })
      ).rejects.toThrow('CA not initialized')
    })
  })

  // ===== CA Bundle =====

  describe('getCaBundle', () => {
    it('should return services and transport bundles after init', async () => {
      await manager.initialize()
      const bundle = await manager.getCaBundle()

      expect(bundle.trustDomain).toBe('test.example.com')

      // Services bundle: services CA + root CA
      expect(bundle.servicesBundle).toHaveLength(2)
      expect(bundle.servicesBundle[0]).toContain('BEGIN CERTIFICATE')
      expect(bundle.servicesBundle[1]).toContain('BEGIN CERTIFICATE')

      // Transport bundle: transport CA + root CA
      expect(bundle.transportBundle).toHaveLength(2)
      expect(bundle.transportBundle[0]).toContain('BEGIN CERTIFICATE')
      expect(bundle.transportBundle[1]).toContain('BEGIN CERTIFICATE')

      // Root is the last in both bundles
      expect(bundle.servicesBundle[1]).toBe(bundle.transportBundle[1])

      // Version is derived from root fingerprint
      expect(bundle.version).toMatch(/^v/)
      expect(bundle.expiresAt).toBeTypeOf('string')
    })

    it('should throw if CA not initialized', async () => {
      expect(manager.getCaBundle()).rejects.toThrow('CA not initialized')
    })
  })

  // ===== Deny List =====

  describe('deny list', () => {
    beforeEach(async () => {
      await manager.initialize()
    })

    it('should add identity to deny list and return expiring certs', async () => {
      const spiffeId = 'spiffe://test.example.com/node/n1'

      // First, issue a cert
      const { csrPem } = await generateCSR(spiffeId, 'n1')
      await manager.signCSR({
        csrPem,
        serviceType: 'node',
        instanceId: 'n1',
      })

      // Deny the identity
      const result = await manager.denyIdentity(spiffeId, 'compromised key')
      expect(result.expiringCerts).toHaveLength(1)
      expect(result.expiringCerts[0].serial).toBeTypeOf('string')
      expect(result.expiringCerts[0].expiresAt).toBeTypeOf('string')
    })

    it('should allow re-enabling a denied identity', async () => {
      const spiffeId = 'spiffe://test.example.com/node/temp'
      await manager.denyIdentity(spiffeId, 'temporary')

      const denied = await manager.getStore().isDenied(spiffeId)
      expect(denied).toBe(true)

      await manager.allowIdentity(spiffeId)
      const deniedAfter = await manager.getStore().isDenied(spiffeId)
      expect(deniedAfter).toBe(false)
    })

    it('should list denied identities', async () => {
      await manager.denyIdentity('spiffe://test.example.com/node/a', 'reason-a')
      await new Promise((r) => setTimeout(r, 2))
      await manager.denyIdentity('spiffe://test.example.com/node/b', 'reason-b')

      const list = await manager.listDeniedIdentities()
      expect(list).toHaveLength(2)
    })

    it('should allow signing after identity is re-enabled', async () => {
      const spiffeId = 'spiffe://test.example.com/node/reallowed'
      await manager.denyIdentity(spiffeId, 'temp deny')

      // Deny should block signing
      const { csrPem } = await generateCSR(spiffeId, 'reallowed')
      expect(
        manager.signCSR({
          csrPem,
          serviceType: 'node',
          instanceId: 'reallowed',
        })
      ).rejects.toThrow('Identity denied')

      // Re-allow should unblock
      await manager.allowIdentity(spiffeId)
      const { csrPem: csrPem2 } = await generateCSR(spiffeId, 'reallowed')
      const result = await manager.signCSR({
        csrPem: csrPem2,
        serviceType: 'node',
        instanceId: 'reallowed',
      })
      expect(result.certificatePem).toContain('BEGIN CERTIFICATE')
    })
  })

  // ===== Status =====

  describe('getStatus', () => {
    it('should return uninitialized before initialize()', async () => {
      const status = await manager.getStatus()
      expect(status.status).toBe('uninitialized')
      expect(status.trustDomain).toBe('test.example.com')
      expect(status.rootCa).toBeNull()
      expect(status.servicesCa).toBeNull()
      expect(status.transportCa).toBeNull()
      expect(status.activeCertCount).toBe(0)
      expect(status.deniedIdentityCount).toBe(0)
    })

    it('should return healthy after initialize()', async () => {
      await manager.initialize()
      const status = await manager.getStatus()

      expect(status.status).toBe('healthy')
      expect(status.rootCa).not.toBeNull()
      expect(status.rootCa!.commonName).toBe('Catalyst Root CA')
      expect(status.rootCa!.algorithm).toBe('ECDSA P-384')
      expect(status.servicesCa).not.toBeNull()
      expect(status.servicesCa!.commonName).toBe('Catalyst Services CA')
      expect(status.transportCa).not.toBeNull()
      expect(status.transportCa!.commonName).toBe('Catalyst Transport CA')
      expect(status.warnings).toHaveLength(0)
    })

    it('should track active cert and deny counts', async () => {
      await manager.initialize()

      // Issue a cert
      const { csrPem } = await generateCSR('spiffe://test.example.com/node/n1', 'n1')
      await manager.signCSR({
        csrPem,
        serviceType: 'node',
        instanceId: 'n1',
      })

      // Deny an identity
      await manager.denyIdentity('spiffe://test.example.com/node/bad', 'compromised')

      const status = await manager.getStatus()
      expect(status.activeCertCount).toBe(1)
      expect(status.deniedIdentityCount).toBe(1)
    })
  })

  // ===== Maintenance =====

  describe('purgeExpired', () => {
    it('should return zero when nothing to purge', async () => {
      await manager.initialize()
      const count = await manager.purgeExpired()
      expect(count).toBe(0)
    })
  })

  // ===== Accessors =====

  describe('accessors', () => {
    it('should expose the store', () => {
      expect(manager.getStore()).toBeDefined()
    })

    it('should expose the backend', () => {
      expect(manager.getBackend()).toBeDefined()
    })

    it('should expose the trust domain', () => {
      expect(manager.getTrustDomain()).toBe('test.example.com')
    })
  })

  // ===== Ephemeral factory =====

  describe('ephemeral()', () => {
    it('should create a working in-memory instance', async () => {
      const eph = CertificateManager.ephemeral()
      await eph.initialize()
      expect(eph.isInitialized()).toBe(true)

      const status = await eph.getStatus()
      expect(status.status).toBe('healthy')
    })

    it('should use default trust domain', () => {
      const eph = CertificateManager.ephemeral()
      expect(eph.getTrustDomain()).toBe('catalyst.example.com')
    })

    it('should accept custom trust domain', () => {
      const eph = CertificateManager.ephemeral({
        trustDomain: 'custom.domain',
      })
      expect(eph.getTrustDomain()).toBe('custom.domain')
    })
  })
})
