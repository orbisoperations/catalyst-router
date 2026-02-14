import { describe, test, expect } from 'bun:test'
import { CertificateManager } from '../../src/certificate-manager.js'
import * as x509 from '@peculiar/x509'

x509.cryptoProvider.set(crypto)

describe('PKI full lifecycle integration test', () => {
  test('complete flow: init -> sign CSR -> verify chain -> deny -> renew rejected -> allow -> renew', async () => {
    // 1. Create ephemeral CertificateManager
    const cm = CertificateManager.ephemeral({ trustDomain: 'test.example.com' })

    // 2. Initialize CA hierarchy
    const initResult = await cm.initialize()
    expect(initResult.rootFingerprint).toBeTruthy()
    expect(initResult.servicesCaFingerprint).toBeTruthy()
    expect(initResult.transportCaFingerprint).toBeTruthy()

    // 3. Generate a key pair and CSR for an orchestrator
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, [
      'sign',
      'verify',
    ])
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({
      name: 'CN=node-a.test.local',
      keys: keyPair,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
      extensions: [
        new x509.SubjectAlternativeNameExtension([
          { type: 'url', value: 'spiffe://test.example.com/orchestrator/node-a.test.local' },
          { type: 'dns', value: 'node-a.test.local' },
        ]),
      ],
    })

    // 4. Sign the CSR
    const signResult = await cm.signCSR({
      csrPem: csr.toString('pem'),
      serviceType: 'orchestrator',
      instanceId: 'node-a.test.local',
    })
    expect(signResult.certificatePem).toContain('BEGIN CERTIFICATE')
    expect(signResult.chain).toHaveLength(2) // services CA + root CA
    expect(signResult.fingerprint).toBeTruthy()
    expect(signResult.serial).toBeTruthy()
    expect(signResult.expiresAt).toBeTruthy()
    expect(signResult.renewAfter).toBeTruthy()

    // 5. Verify the certificate chain
    const cert = new x509.X509Certificate(signResult.certificatePem)
    const servicesCaCert = new x509.X509Certificate(signResult.chain[0])
    const rootCaCert = new x509.X509Certificate(signResult.chain[1])

    // Verify leaf signed by services CA
    expect(cert.issuer).toBe(servicesCaCert.subject)
    // Verify services CA signed by root CA
    expect(servicesCaCert.issuer).toBe(rootCaCert.subject)
    // Verify root is self-signed
    expect(rootCaCert.issuer).toBe(rootCaCert.subject)

    // 6. Verify SPIFFE URI SAN
    const sanExt = cert.getExtension('2.5.29.17') // subjectAltName OID
    expect(sanExt).toBeTruthy()

    // 7. Get CA bundle
    const bundle = await cm.getCaBundle()
    expect(bundle.trustDomain).toBe('test.example.com')
    expect(bundle.servicesBundle).toHaveLength(2) // services CA + root
    expect(bundle.transportBundle).toHaveLength(2) // transport CA + root

    // 8. Deny the identity
    const denyResult = await cm.denyIdentity(
      'spiffe://test.example.com/orchestrator/node-a.test.local',
      'Test denial'
    )
    expect(denyResult.expiringCerts).toHaveLength(1)

    // 9. Attempt to sign another CSR for the same identity — should fail
    const keyPair2 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, [
      'sign',
      'verify',
    ])
    const csr2 = await x509.Pkcs10CertificateRequestGenerator.create({
      name: 'CN=node-a.test.local',
      keys: keyPair2,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
      extensions: [
        new x509.SubjectAlternativeNameExtension([
          { type: 'url', value: 'spiffe://test.example.com/orchestrator/node-a.test.local' },
        ]),
      ],
    })

    await expect(
      cm.signCSR({
        csrPem: csr2.toString('pem'),
        serviceType: 'orchestrator',
        instanceId: 'node-a.test.local',
      })
    ).rejects.toThrow('Identity denied')

    // 10. Re-enable the identity
    await cm.allowIdentity('spiffe://test.example.com/orchestrator/node-a.test.local')

    // 11. Now renewal should succeed
    const renewResult = await cm.signCSR({
      csrPem: csr2.toString('pem'),
      serviceType: 'orchestrator',
      instanceId: 'node-a.test.local',
    })
    expect(renewResult.certificatePem).toContain('BEGIN CERTIFICATE')

    // 12. Verify status
    const status = await cm.getStatus()
    expect(status.status).toBe('healthy')
    expect(status.activeCertCount).toBeGreaterThanOrEqual(2) // 2 orchestrator certs
    expect(status.deniedIdentityCount).toBe(0)
    expect(status.rootCa).toBeTruthy()
    expect(status.servicesCa).toBeTruthy()
    expect(status.transportCa).toBeTruthy()
    expect(status.warnings).toHaveLength(0)
  })

  test('envoy certificates are signed by transport CA, not services CA', async () => {
    const cm = CertificateManager.ephemeral({ trustDomain: 'test.example.com' })
    await cm.initialize()

    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, [
      'sign',
      'verify',
    ])
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({
      name: 'CN=envoy-proxy-a',
      keys: keyPair,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
      extensions: [
        new x509.SubjectAlternativeNameExtension([
          { type: 'url', value: 'spiffe://test.example.com/envoy/app/node-a.test.local' },
        ]),
      ],
    })

    const result = await cm.signCSR({
      csrPem: csr.toString('pem'),
      serviceType: 'envoy/app',
      instanceId: 'node-a.test.local',
    })

    // Verify signed by Transport CA (not Services CA)
    const cert = new x509.X509Certificate(result.certificatePem)
    const transportCa = new x509.X509Certificate(result.chain[0])
    expect(cert.issuer).toBe(transportCa.subject)
    expect(transportCa.subject).toContain('Transport')
  })

  test('idempotent initialization returns same fingerprints', async () => {
    const cm = CertificateManager.ephemeral()
    const first = await cm.initialize()
    const second = await cm.initialize()
    expect(first.rootFingerprint).toBe(second.rootFingerprint)
    expect(first.servicesCaFingerprint).toBe(second.servicesCaFingerprint)
    expect(first.transportCaFingerprint).toBe(second.transportCaFingerprint)
  })

  test('TTL capping: requested TTL exceeding max is capped', async () => {
    const cm = CertificateManager.ephemeral({
      trustDomain: 'test.example.com',
      maxSvidTtlSeconds: 3600, // 1 hour max
    })
    await cm.initialize()

    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, [
      'sign',
      'verify',
    ])
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({
      name: 'CN=test-node',
      keys: keyPair,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
      extensions: [
        new x509.SubjectAlternativeNameExtension([
          { type: 'url', value: 'spiffe://test.example.com/node/test-node' },
        ]),
      ],
    })

    // Request 24 hours, should be capped to 1 hour
    const result = await cm.signCSR({
      csrPem: csr.toString('pem'),
      serviceType: 'node',
      instanceId: 'test-node',
      ttlSeconds: 86400,
    })

    const cert = new x509.X509Certificate(result.certificatePem)
    const lifetimeMs = new Date(cert.notAfter).getTime() - new Date(cert.notBefore).getTime()
    // Should be ~1 hour (3600s), not 24 hours
    expect(lifetimeMs).toBeLessThanOrEqual(3600 * 1000 + 5000) // 1hr + 5s tolerance
  })

  test('denied identities list tracks correctly', async () => {
    const cm = CertificateManager.ephemeral({ trustDomain: 'test.example.com' })
    await cm.initialize()

    // Initially empty
    let denied = await cm.listDeniedIdentities()
    expect(denied).toHaveLength(0)

    // Deny two identities
    await cm.denyIdentity('spiffe://test.example.com/node/a', 'reason-a')
    await cm.denyIdentity('spiffe://test.example.com/node/b', 'reason-b')

    denied = await cm.listDeniedIdentities()
    expect(denied).toHaveLength(2)

    // Allow one back
    await cm.allowIdentity('spiffe://test.example.com/node/a')
    denied = await cm.listDeniedIdentities()
    expect(denied).toHaveLength(1)
    expect(denied[0].spiffeId).toBe('spiffe://test.example.com/node/b')
  })
})
