import { describe, test, expect, beforeAll } from 'bun:test'
import * as x509 from '@peculiar/x509'
import { WebCryptoSigningBackend } from '../../src/signing/webcrypto-signing-backend.js'

// Ensure @peculiar/x509 uses Bun's crypto
x509.cryptoProvider.set(crypto)

/** OID for the Name Constraints extension (RFC 5280 Section 4.2.1.10) */
const NAME_CONSTRAINTS_OID = '2.5.29.30'

/**
 * Parse permitted URI values from a raw Name Constraints DER extension value.
 * Used in tests to verify the backend correctly encodes name constraints.
 */
function parseNameConstraintsUris(extensionValue: ArrayBuffer): string[] {
  const bytes = new Uint8Array(extensionValue)
  const uris: string[] = []
  // Walk the DER looking for tag 0x86 (uniformResourceIdentifier [6] IMPLICIT)
  let i = 0
  while (i < bytes.length) {
    if (bytes[i] === 0x86) {
      // Next byte(s) are the length
      let len = bytes[i + 1]
      let offset = i + 2
      if (len & 0x80) {
        const numLenBytes = len & 0x7f
        len = 0
        for (let j = 0; j < numLenBytes; j++) {
          len = (len << 8) | bytes[offset + j]
        }
        offset += numLenBytes
      }
      uris.push(new TextDecoder().decode(bytes.slice(offset, offset + len)))
      i = offset + len
    } else {
      i++
    }
  }
  return uris
}

describe('WebCryptoSigningBackend', () => {
  let backend: WebCryptoSigningBackend

  beforeAll(() => {
    backend = new WebCryptoSigningBackend()
  })

  // ===== Key generation =====

  describe('generateKeyPair', () => {
    test('returns a P-384 key pair with sign and verify usages', async () => {
      const keyPair = await backend.generateKeyPair()

      expect(keyPair.privateKey).toBeDefined()
      expect(keyPair.publicKey).toBeDefined()

      // Verify algorithm is ECDSA P-384
      const privAlg = keyPair.privateKey.algorithm as EcKeyAlgorithm
      expect(privAlg.name).toBe('ECDSA')
      expect(privAlg.namedCurve).toBe('P-384')

      const pubAlg = keyPair.publicKey.algorithm as EcKeyAlgorithm
      expect(pubAlg.name).toBe('ECDSA')
      expect(pubAlg.namedCurve).toBe('P-384')

      // Verify key usages
      expect(keyPair.privateKey.usages).toContain('sign')
      expect(keyPair.publicKey.usages).toContain('verify')

      // Keys must be extractable for PEM export
      expect(keyPair.privateKey.extractable).toBe(true)
      expect(keyPair.publicKey.extractable).toBe(true)
    })

    test('generates unique key pairs on each call', async () => {
      const kp1 = await backend.generateKeyPair()
      const kp2 = await backend.generateKeyPair()

      // Export and compare — keys must be different
      const pub1 = await backend.exportPublicKeyPem(kp1.publicKey)
      const pub2 = await backend.exportPublicKeyPem(kp2.publicKey)
      expect(pub1).not.toBe(pub2)
    })
  })

  // ===== Self-signed Root CA =====

  describe('signCertificate — Root CA', () => {
    let rootKeyPair: CryptoKeyPair
    let rootPem: string
    let rootCert: x509.X509Certificate

    beforeAll(async () => {
      rootKeyPair = await backend.generateKeyPair()
      rootPem = await backend.signCertificate({
        subjectCN: 'Catalyst Root CA',
        signingKey: rootKeyPair.privateKey,
        signingCert: '', // self-signed: empty string
        subjectPublicKey: rootKeyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 1,
        keyUsage: { keyCertSign: true, crlSign: true },
      })
      rootCert = new x509.X509Certificate(rootPem)
    })

    test('has correct subject CN', () => {
      expect(rootCert.subject).toBe('CN=Catalyst Root CA')
    })

    test('is self-signed (issuer = subject)', () => {
      expect(rootCert.issuer).toBe(rootCert.subject)
    })

    test('has Basic Constraints CA:TRUE with pathlen:1', () => {
      const bc = rootCert.getExtension(x509.BasicConstraintsExtension)
      expect(bc).toBeDefined()
      expect(bc!.ca).toBe(true)
      expect(bc!.pathLength).toBe(1)
      expect(bc!.critical).toBe(true)
    })

    test('has Key Usage keyCertSign + cRLSign (critical)', () => {
      const ku = rootCert.getExtension(x509.KeyUsagesExtension)
      expect(ku).toBeDefined()
      expect(ku!.critical).toBe(true)
      expect(ku!.usages & x509.KeyUsageFlags.keyCertSign).toBeTruthy()
      expect(ku!.usages & x509.KeyUsageFlags.cRLSign).toBeTruthy()
      // Must NOT have digitalSignature
      expect(ku!.usages & x509.KeyUsageFlags.digitalSignature).toBeFalsy()
    })

    test('has SubjectKeyIdentifier (SKI) extension', () => {
      const ski = rootCert.getExtension(x509.SubjectKeyIdentifierExtension)
      expect(ski).toBeDefined()
      expect(ski!.keyId).toBeTruthy()
      // SKI should be a non-empty hex string
      expect(ski!.keyId.length).toBeGreaterThan(0)
    })

    test('does NOT have AuthorityKeyIdentifier (self-signed)', () => {
      const aki = rootCert.getExtension(x509.AuthorityKeyIdentifierExtension)
      expect(aki).toBeNull()
    })

    test('does NOT have Extended Key Usage (CAs should not have EKU)', () => {
      const eku = rootCert.getExtension(x509.ExtendedKeyUsageExtension)
      expect(eku).toBeNull()
    })

    test('does NOT have Subject Alternative Names', () => {
      const san = rootCert.getExtension(x509.SubjectAlternativeNameExtension)
      expect(san).toBeNull()
    })

    test('validity period matches parameters', () => {
      expect(rootCert.notBefore.getTime()).toBe(new Date('2025-01-01T00:00:00Z').getTime())
      expect(rootCert.notAfter.getTime()).toBe(new Date('2035-01-01T00:00:00Z').getTime())
    })

    test('outputs valid PEM format', () => {
      expect(rootPem).toContain('-----BEGIN CERTIFICATE-----')
      expect(rootPem).toContain('-----END CERTIFICATE-----')
    })

    test('signature is valid (self-signed verification)', async () => {
      const isValid = await rootCert.verify({ publicKey: rootKeyPair.publicKey })
      expect(isValid).toBe(true)
    })
  })

  // ===== Intermediate CA (Services CA) =====

  describe('signCertificate — Services Intermediate CA', () => {
    let rootKeyPair: CryptoKeyPair
    let rootPem: string
    let servicesKeyPair: CryptoKeyPair
    let servicesPem: string
    let servicesCert: x509.X509Certificate
    let rootCert: x509.X509Certificate

    beforeAll(async () => {
      // Generate root CA first
      rootKeyPair = await backend.generateKeyPair()
      rootPem = await backend.signCertificate({
        subjectCN: 'Catalyst Root CA',
        signingKey: rootKeyPair.privateKey,
        signingCert: '',
        subjectPublicKey: rootKeyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 1,
        keyUsage: { keyCertSign: true, crlSign: true },
      })
      rootCert = new x509.X509Certificate(rootPem)

      // Generate Services CA signed by root
      servicesKeyPair = await backend.generateKeyPair()
      servicesPem = await backend.signCertificate({
        subjectCN: 'Catalyst Services CA',
        signingKey: rootKeyPair.privateKey,
        signingCert: rootPem,
        subjectPublicKey: servicesKeyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2027-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 0,
        keyUsage: { keyCertSign: true, crlSign: true },
        nameConstraints: {
          permittedUris: [
            'spiffe://catalyst.example.com/orchestrator/',
            'spiffe://catalyst.example.com/auth/',
            'spiffe://catalyst.example.com/node/',
            'spiffe://catalyst.example.com/gateway/',
          ],
        },
      })
      servicesCert = new x509.X509Certificate(servicesPem)
    })

    test('has correct subject CN', () => {
      expect(servicesCert.subject).toBe('CN=Catalyst Services CA')
    })

    test('issuer is the Root CA', () => {
      expect(servicesCert.issuer).toBe('CN=Catalyst Root CA')
    })

    test('has Basic Constraints CA:TRUE with pathlen:0', () => {
      const bc = servicesCert.getExtension(x509.BasicConstraintsExtension)
      expect(bc).toBeDefined()
      expect(bc!.ca).toBe(true)
      expect(bc!.pathLength).toBe(0)
      expect(bc!.critical).toBe(true)
    })

    test('has Key Usage keyCertSign + cRLSign (critical)', () => {
      const ku = servicesCert.getExtension(x509.KeyUsagesExtension)
      expect(ku).toBeDefined()
      expect(ku!.critical).toBe(true)
      expect(ku!.usages & x509.KeyUsageFlags.keyCertSign).toBeTruthy()
      expect(ku!.usages & x509.KeyUsageFlags.cRLSign).toBeTruthy()
    })

    test('has SubjectKeyIdentifier (SKI) extension', () => {
      const ski = servicesCert.getExtension(x509.SubjectKeyIdentifierExtension)
      expect(ski).toBeDefined()
      expect(ski!.keyId.length).toBeGreaterThan(0)
    })

    test('has AuthorityKeyIdentifier (AKI) matching root SKI', () => {
      const aki = servicesCert.getExtension(x509.AuthorityKeyIdentifierExtension)
      expect(aki).toBeDefined()

      const rootSki = rootCert.getExtension(x509.SubjectKeyIdentifierExtension)
      expect(rootSki).toBeDefined()
      expect(aki!.keyId).toBe(rootSki!.keyId)
    })

    test('has Name Constraints (critical) with permitted SPIFFE URIs for services', () => {
      const nc = servicesCert.getExtension(NAME_CONSTRAINTS_OID)
      expect(nc).toBeDefined()
      expect(nc!.critical).toBe(true)

      // Parse the raw DER to extract permitted URI values
      const uris = parseNameConstraintsUris(nc!.value)
      expect(uris.length).toBe(4)
      expect(uris).toContain('spiffe://catalyst.example.com/orchestrator/')
      expect(uris).toContain('spiffe://catalyst.example.com/auth/')
      expect(uris).toContain('spiffe://catalyst.example.com/node/')
      expect(uris).toContain('spiffe://catalyst.example.com/gateway/')
    })

    test('signature is valid (signed by root)', async () => {
      const isValid = await servicesCert.verify({
        signatureOnly: true,
        publicKey: rootKeyPair.publicKey,
      })
      expect(isValid).toBe(true)
    })
  })

  // ===== Intermediate CA (Transport CA) =====

  describe('signCertificate — Transport Intermediate CA', () => {
    let rootKeyPair: CryptoKeyPair
    let rootPem: string
    let transportKeyPair: CryptoKeyPair
    let transportPem: string
    let transportCert: x509.X509Certificate

    beforeAll(async () => {
      rootKeyPair = await backend.generateKeyPair()
      rootPem = await backend.signCertificate({
        subjectCN: 'Catalyst Root CA',
        signingKey: rootKeyPair.privateKey,
        signingCert: '',
        subjectPublicKey: rootKeyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 1,
        keyUsage: { keyCertSign: true, crlSign: true },
      })

      transportKeyPair = await backend.generateKeyPair()
      transportPem = await backend.signCertificate({
        subjectCN: 'Catalyst Transport CA',
        signingKey: rootKeyPair.privateKey,
        signingCert: rootPem,
        subjectPublicKey: transportKeyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2027-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 0,
        keyUsage: { keyCertSign: true, crlSign: true },
        nameConstraints: {
          permittedUris: ['spiffe://catalyst.example.com/envoy/'],
        },
      })
      transportCert = new x509.X509Certificate(transportPem)
    })

    test('has correct subject and issuer', () => {
      expect(transportCert.subject).toBe('CN=Catalyst Transport CA')
      expect(transportCert.issuer).toBe('CN=Catalyst Root CA')
    })

    test('has Name Constraints permitting only envoy/ SPIFFE URIs', () => {
      const nc = transportCert.getExtension(NAME_CONSTRAINTS_OID)
      expect(nc).toBeDefined()
      expect(nc!.critical).toBe(true)

      // Parse the raw DER to extract permitted URI values
      const uris = parseNameConstraintsUris(nc!.value)
      expect(uris.length).toBe(1)
      expect(uris[0]).toBe('spiffe://catalyst.example.com/envoy/')
    })
  })

  // ===== End-entity certificate (orchestrator) =====

  describe('signCertificate — End-entity (orchestrator with serverAuth+clientAuth)', () => {
    let rootKeyPair: CryptoKeyPair
    let rootPem: string
    let servicesKeyPair: CryptoKeyPair
    let servicesPem: string
    let servicesCert: x509.X509Certificate
    let leafKeyPair: CryptoKeyPair
    let leafPem: string
    let leafCert: x509.X509Certificate

    beforeAll(async () => {
      // Root CA
      rootKeyPair = await backend.generateKeyPair()
      rootPem = await backend.signCertificate({
        subjectCN: 'Catalyst Root CA',
        signingKey: rootKeyPair.privateKey,
        signingCert: '',
        subjectPublicKey: rootKeyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 1,
        keyUsage: { keyCertSign: true, crlSign: true },
      })

      // Services CA
      servicesKeyPair = await backend.generateKeyPair()
      servicesPem = await backend.signCertificate({
        subjectCN: 'Catalyst Services CA',
        signingKey: rootKeyPair.privateKey,
        signingCert: rootPem,
        subjectPublicKey: servicesKeyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2027-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 0,
        keyUsage: { keyCertSign: true, crlSign: true },
      })
      servicesCert = new x509.X509Certificate(servicesPem)

      // End-entity orchestrator cert
      leafKeyPair = await backend.generateKeyPair()
      leafPem = await backend.signCertificate({
        subjectCN: 'node-a.somebiz.local.io',
        sanUri: 'spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io',
        sanDns: ['node-a.somebiz.local.io', 'orch-node-a'],
        signingKey: servicesKeyPair.privateKey,
        signingCert: servicesPem,
        subjectPublicKey: leafKeyPair.publicKey,
        notBefore: new Date('2025-06-01T00:00:00Z'),
        notAfter: new Date('2025-06-01T01:00:00Z'), // 1 hour SVID
        isCa: false,
        keyUsage: { digitalSignature: true },
        extKeyUsage: ['serverAuth', 'clientAuth'],
      })
      leafCert = new x509.X509Certificate(leafPem)
    })

    test('has correct subject CN', () => {
      expect(leafCert.subject).toBe('CN=node-a.somebiz.local.io')
    })

    test('issuer is the Services CA', () => {
      expect(leafCert.issuer).toBe('CN=Catalyst Services CA')
    })

    test('has Basic Constraints CA:FALSE (critical)', () => {
      const bc = leafCert.getExtension(x509.BasicConstraintsExtension)
      expect(bc).toBeDefined()
      expect(bc!.ca).toBe(false)
      expect(bc!.critical).toBe(true)
    })

    test('has Key Usage digitalSignature only (critical)', () => {
      const ku = leafCert.getExtension(x509.KeyUsagesExtension)
      expect(ku).toBeDefined()
      expect(ku!.critical).toBe(true)
      expect(ku!.usages & x509.KeyUsageFlags.digitalSignature).toBeTruthy()
      // Must NOT have keyCertSign or cRLSign
      expect(ku!.usages & x509.KeyUsageFlags.keyCertSign).toBeFalsy()
      expect(ku!.usages & x509.KeyUsageFlags.cRLSign).toBeFalsy()
    })

    test('has Extended Key Usage serverAuth + clientAuth (non-critical)', () => {
      const eku = leafCert.getExtension(x509.ExtendedKeyUsageExtension)
      expect(eku).toBeDefined()
      expect(eku!.critical).toBe(false)
      expect(eku!.usages).toContain(x509.ExtendedKeyUsage.serverAuth)
      expect(eku!.usages).toContain(x509.ExtendedKeyUsage.clientAuth)
    })

    test('has SPIFFE URI SAN and DNS SANs', () => {
      const san = leafCert.getExtension(x509.SubjectAlternativeNameExtension)
      expect(san).toBeDefined()

      const names = san!.names
      const uriNames = names.items.filter((n: x509.GeneralName) => n.type === 'url')
      const dnsNames = names.items.filter((n: x509.GeneralName) => n.type === 'dns')

      // Exactly one URI SAN (SPIFFE)
      expect(uriNames.length).toBe(1)
      expect(uriNames[0].value).toBe(
        'spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io'
      )

      // Two DNS SANs
      expect(dnsNames.length).toBe(2)
      const dnsValues = dnsNames.map((n: x509.GeneralName) => n.value)
      expect(dnsValues).toContain('node-a.somebiz.local.io')
      expect(dnsValues).toContain('orch-node-a')
    })

    test('has SubjectKeyIdentifier (SKI) extension', () => {
      const ski = leafCert.getExtension(x509.SubjectKeyIdentifierExtension)
      expect(ski).toBeDefined()
      expect(ski!.keyId.length).toBeGreaterThan(0)
    })

    test('has AuthorityKeyIdentifier (AKI) matching Services CA SKI', () => {
      const aki = leafCert.getExtension(x509.AuthorityKeyIdentifierExtension)
      expect(aki).toBeDefined()

      const servicesSki = servicesCert.getExtension(x509.SubjectKeyIdentifierExtension)
      expect(servicesSki).toBeDefined()
      expect(aki!.keyId).toBe(servicesSki!.keyId)
    })

    test('has 1-hour validity period', () => {
      const duration = leafCert.notAfter.getTime() - leafCert.notBefore.getTime()
      expect(duration).toBe(60 * 60 * 1000) // 1 hour in ms
    })

    test('signature is valid (signed by Services CA)', async () => {
      const isValid = await leafCert.verify({
        signatureOnly: true,
        publicKey: servicesKeyPair.publicKey,
      })
      expect(isValid).toBe(true)
    })

    test('does NOT have Name Constraints (end-entity)', () => {
      const nc = leafCert.getExtension(NAME_CONSTRAINTS_OID)
      expect(nc).toBeNull()
    })
  })

  // ===== End-entity certificate (gateway — serverAuth only) =====

  describe('signCertificate — End-entity (gateway with serverAuth only)', () => {
    let servicesKeyPair: CryptoKeyPair
    let servicesPem: string
    let leafKeyPair: CryptoKeyPair
    let leafCert: x509.X509Certificate

    beforeAll(async () => {
      const rootKeyPair = await backend.generateKeyPair()
      const rootPem = await backend.signCertificate({
        subjectCN: 'Catalyst Root CA',
        signingKey: rootKeyPair.privateKey,
        signingCert: '',
        subjectPublicKey: rootKeyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 1,
        keyUsage: { keyCertSign: true, crlSign: true },
      })

      servicesKeyPair = await backend.generateKeyPair()
      servicesPem = await backend.signCertificate({
        subjectCN: 'Catalyst Services CA',
        signingKey: rootKeyPair.privateKey,
        signingCert: rootPem,
        subjectPublicKey: servicesKeyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2027-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 0,
        keyUsage: { keyCertSign: true, crlSign: true },
      })

      // Gateway: serverAuth ONLY (ADR 0011 Section 3.7)
      leafKeyPair = await backend.generateKeyPair()
      const leafPem = await backend.signCertificate({
        subjectCN: 'gateway-a',
        sanUri: 'spiffe://catalyst.example.com/gateway/gateway-a',
        sanDns: ['gateway-a'],
        signingKey: servicesKeyPair.privateKey,
        signingCert: servicesPem,
        subjectPublicKey: leafKeyPair.publicKey,
        notBefore: new Date('2025-06-01T00:00:00Z'),
        notAfter: new Date('2025-06-01T01:00:00Z'),
        isCa: false,
        keyUsage: { digitalSignature: true },
        extKeyUsage: ['serverAuth'],
      })
      leafCert = new x509.X509Certificate(leafPem)
    })

    test('has Extended Key Usage serverAuth only (no clientAuth)', () => {
      const eku = leafCert.getExtension(x509.ExtendedKeyUsageExtension)
      expect(eku).toBeDefined()
      expect(eku!.usages).toContain(x509.ExtendedKeyUsage.serverAuth)
      expect(eku!.usages).not.toContain(x509.ExtendedKeyUsage.clientAuth)
    })

    test('has SPIFFE URI SAN for gateway', () => {
      const san = leafCert.getExtension(x509.SubjectAlternativeNameExtension)
      expect(san).toBeDefined()

      const uriNames = san!.names.items.filter((n: x509.GeneralName) => n.type === 'url')
      expect(uriNames.length).toBe(1)
      expect(uriNames[0].value).toBe('spiffe://catalyst.example.com/gateway/gateway-a')
    })
  })

  // ===== End-entity certificate (envoy — signed by Transport CA) =====

  describe('signCertificate — End-entity (envoy/app signed by Transport CA)', () => {
    let transportKeyPair: CryptoKeyPair
    let transportPem: string
    let transportCert: x509.X509Certificate
    let leafCert: x509.X509Certificate

    beforeAll(async () => {
      const rootKeyPair = await backend.generateKeyPair()
      const rootPem = await backend.signCertificate({
        subjectCN: 'Catalyst Root CA',
        signingKey: rootKeyPair.privateKey,
        signingCert: '',
        subjectPublicKey: rootKeyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 1,
        keyUsage: { keyCertSign: true, crlSign: true },
      })

      transportKeyPair = await backend.generateKeyPair()
      transportPem = await backend.signCertificate({
        subjectCN: 'Catalyst Transport CA',
        signingKey: rootKeyPair.privateKey,
        signingCert: rootPem,
        subjectPublicKey: transportKeyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2027-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 0,
        keyUsage: { keyCertSign: true, crlSign: true },
        nameConstraints: {
          permittedUris: ['spiffe://catalyst.example.com/envoy/'],
        },
      })
      transportCert = new x509.X509Certificate(transportPem)

      const leafKeyPair = await backend.generateKeyPair()
      const leafPem = await backend.signCertificate({
        subjectCN: 'node-a.somebiz.local.io',
        sanUri: 'spiffe://catalyst.example.com/envoy/app/node-a.somebiz.local.io',
        sanDns: ['node-a.somebiz.local.io'],
        signingKey: transportKeyPair.privateKey,
        signingCert: transportPem,
        subjectPublicKey: leafKeyPair.publicKey,
        notBefore: new Date('2025-06-01T00:00:00Z'),
        notAfter: new Date('2025-06-01T01:00:00Z'),
        isCa: false,
        keyUsage: { digitalSignature: true },
        extKeyUsage: ['serverAuth', 'clientAuth'],
      })
      leafCert = new x509.X509Certificate(leafPem)
    })

    test('issuer is Transport CA', () => {
      expect(leafCert.issuer).toBe('CN=Catalyst Transport CA')
    })

    test('has SPIFFE URI SAN for envoy/app', () => {
      const san = leafCert.getExtension(x509.SubjectAlternativeNameExtension)
      expect(san).toBeDefined()

      const uriNames = san!.names.items.filter((n: x509.GeneralName) => n.type === 'url')
      expect(uriNames.length).toBe(1)
      expect(uriNames[0].value).toBe(
        'spiffe://catalyst.example.com/envoy/app/node-a.somebiz.local.io'
      )
    })

    test('AKI matches Transport CA SKI', () => {
      const aki = leafCert.getExtension(x509.AuthorityKeyIdentifierExtension)
      const transportSki = transportCert.getExtension(x509.SubjectKeyIdentifierExtension)
      expect(aki).toBeDefined()
      expect(transportSki).toBeDefined()
      expect(aki!.keyId).toBe(transportSki!.keyId)
    })
  })

  // ===== Custom serial number =====

  describe('signCertificate — custom serial number', () => {
    test('uses provided serial number', async () => {
      const keyPair = await backend.generateKeyPair()
      const customSerial = 'deadbeef01234567'
      const pem = await backend.signCertificate({
        subjectCN: 'Test CA',
        signingKey: keyPair.privateKey,
        signingCert: '',
        subjectPublicKey: keyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 1,
        keyUsage: { keyCertSign: true, crlSign: true },
        serialNumber: customSerial,
      })
      const cert = new x509.X509Certificate(pem)
      // @peculiar/x509 stores serial as hex, compare lowercased
      expect(cert.serialNumber.toLowerCase()).toBe(customSerial.toLowerCase())
    })
  })

  // ===== PEM key export/import round-trip =====

  describe('exportPrivateKeyPem + importPrivateKeyPem', () => {
    test('round-trips a P-384 private key', async () => {
      const keyPair = await backend.generateKeyPair()
      const pem = await backend.exportPrivateKeyPem(keyPair.privateKey)

      // PEM should be valid PKCS#8 format
      expect(pem).toContain('-----BEGIN PRIVATE KEY-----')
      expect(pem).toContain('-----END PRIVATE KEY-----')

      // Import back
      const imported = await backend.importPrivateKeyPem(pem)
      expect(imported.algorithm).toEqual(keyPair.privateKey.algorithm)
      expect(imported.type).toBe('private')
      expect(imported.extractable).toBe(true)
      expect(imported.usages).toContain('sign')
    })

    test('imported key can sign data verifiable by original public key', async () => {
      const keyPair = await backend.generateKeyPair()

      // Export and reimport private key
      const pem = await backend.exportPrivateKeyPem(keyPair.privateKey)
      const imported = await backend.importPrivateKeyPem(pem)

      // Sign data with the imported key
      const data = new TextEncoder().encode('test-data-for-signing')
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, imported, data)

      // Verify with original public key
      const isValid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-384' },
        keyPair.publicKey,
        signature,
        data
      )
      expect(isValid).toBe(true)
    })
  })

  // ===== Public key export =====

  describe('exportPublicKeyPem', () => {
    test('exports valid SPKI PEM', async () => {
      const keyPair = await backend.generateKeyPair()
      const pem = await backend.exportPublicKeyPem(keyPair.publicKey)

      expect(pem).toContain('-----BEGIN PUBLIC KEY-----')
      expect(pem).toContain('-----END PUBLIC KEY-----')

      // Should be importable back
      const der = x509.PemConverter.decode(pem)[0]
      const imported = await crypto.subtle.importKey(
        'spki',
        der,
        { name: 'ECDSA', namedCurve: 'P-384' },
        true,
        ['verify']
      )
      expect(imported.type).toBe('public')
    })
  })

  // ===== Fingerprint computation =====

  describe('computeFingerprint', () => {
    test('returns base64url-encoded SHA-256 with no padding', async () => {
      const keyPair = await backend.generateKeyPair()
      const pem = await backend.signCertificate({
        subjectCN: 'Fingerprint Test',
        signingKey: keyPair.privateKey,
        signingCert: '',
        subjectPublicKey: keyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 1,
        keyUsage: { keyCertSign: true, crlSign: true },
      })

      const cert = new x509.X509Certificate(pem)
      const fingerprint = await backend.computeFingerprint(cert.rawData)

      // SHA-256 produces 32 bytes -> 43 base64url chars (no padding)
      expect(fingerprint.length).toBe(43)

      // Must be valid base64url: only [A-Za-z0-9_-]
      expect(fingerprint).toMatch(/^[A-Za-z0-9_-]+$/)

      // Must NOT contain base64 padding
      expect(fingerprint).not.toContain('=')

      // Must NOT contain standard base64 chars (+, /)
      expect(fingerprint).not.toContain('+')
      expect(fingerprint).not.toContain('/')
    })

    test('produces consistent fingerprint for the same cert', async () => {
      const keyPair = await backend.generateKeyPair()
      const pem = await backend.signCertificate({
        subjectCN: 'Consistency Test',
        signingKey: keyPair.privateKey,
        signingCert: '',
        subjectPublicKey: keyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 0,
        keyUsage: { keyCertSign: true, crlSign: true },
      })

      const cert = new x509.X509Certificate(pem)
      const fp1 = await backend.computeFingerprint(cert.rawData)
      const fp2 = await backend.computeFingerprint(cert.rawData)
      expect(fp1).toBe(fp2)
    })

    test('produces different fingerprints for different certs', async () => {
      const kp1 = await backend.generateKeyPair()
      const pem1 = await backend.signCertificate({
        subjectCN: 'Cert A',
        signingKey: kp1.privateKey,
        signingCert: '',
        subjectPublicKey: kp1.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 0,
        keyUsage: { keyCertSign: true, crlSign: true },
      })

      const kp2 = await backend.generateKeyPair()
      const pem2 = await backend.signCertificate({
        subjectCN: 'Cert B',
        signingKey: kp2.privateKey,
        signingCert: '',
        subjectPublicKey: kp2.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 0,
        keyUsage: { keyCertSign: true, crlSign: true },
      })

      const cert1 = new x509.X509Certificate(pem1)
      const cert2 = new x509.X509Certificate(pem2)

      const fp1 = await backend.computeFingerprint(cert1.rawData)
      const fp2 = await backend.computeFingerprint(cert2.rawData)
      expect(fp1).not.toBe(fp2)
    })

    test('cross-check against manual SHA-256 computation', async () => {
      const keyPair = await backend.generateKeyPair()
      const pem = await backend.signCertificate({
        subjectCN: 'Cross-check Test',
        signingKey: keyPair.privateKey,
        signingCert: '',
        subjectPublicKey: keyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 0,
        keyUsage: { keyCertSign: true, crlSign: true },
      })

      const cert = new x509.X509Certificate(pem)
      const fingerprint = await backend.computeFingerprint(cert.rawData)

      // Manually compute SHA-256 and base64url encode
      const hash = await crypto.subtle.digest('SHA-256', cert.rawData)
      const manual = btoa(String.fromCharCode(...new Uint8Array(hash)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')

      expect(fingerprint).toBe(manual)
    })
  })

  // ===== Full chain test =====

  describe('full certificate chain — Root -> Intermediate -> End-entity', () => {
    let rootPem: string
    let servicesPem: string
    let leafPem: string

    beforeAll(async () => {
      // Root CA
      const rootKeyPair = await backend.generateKeyPair()
      rootPem = await backend.signCertificate({
        subjectCN: 'Catalyst Root CA',
        signingKey: rootKeyPair.privateKey,
        signingCert: '',
        subjectPublicKey: rootKeyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 1,
        keyUsage: { keyCertSign: true, crlSign: true },
      })

      // Services CA
      const servicesKeyPair = await backend.generateKeyPair()
      servicesPem = await backend.signCertificate({
        subjectCN: 'Catalyst Services CA',
        signingKey: rootKeyPair.privateKey,
        signingCert: rootPem,
        subjectPublicKey: servicesKeyPair.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2027-01-01T00:00:00Z'),
        isCa: true,
        pathLenConstraint: 0,
        keyUsage: { keyCertSign: true, crlSign: true },
        nameConstraints: {
          permittedUris: [
            'spiffe://catalyst.example.com/orchestrator/',
            'spiffe://catalyst.example.com/auth/',
            'spiffe://catalyst.example.com/node/',
            'spiffe://catalyst.example.com/gateway/',
          ],
        },
      })

      // End-entity
      const leafKeyPair = await backend.generateKeyPair()
      leafPem = await backend.signCertificate({
        subjectCN: 'auth-a',
        sanUri: 'spiffe://catalyst.example.com/auth/auth-a',
        sanDns: ['auth', 'auth-a'],
        signingKey: servicesKeyPair.privateKey,
        signingCert: servicesPem,
        subjectPublicKey: leafKeyPair.publicKey,
        notBefore: new Date('2025-06-01T00:00:00Z'),
        notAfter: new Date('2025-06-01T01:00:00Z'),
        isCa: false,
        keyUsage: { digitalSignature: true },
        extKeyUsage: ['serverAuth', 'clientAuth'],
      })
    })

    test('chain has 3 distinct certificates', () => {
      const root = new x509.X509Certificate(rootPem)
      const intermediate = new x509.X509Certificate(servicesPem)
      const leaf = new x509.X509Certificate(leafPem)

      // Each has a unique serial
      expect(root.serialNumber).not.toBe(intermediate.serialNumber)
      expect(intermediate.serialNumber).not.toBe(leaf.serialNumber)
      expect(root.serialNumber).not.toBe(leaf.serialNumber)
    })

    test('chain links correctly: leaf -> services -> root', () => {
      const root = new x509.X509Certificate(rootPem)
      const intermediate = new x509.X509Certificate(servicesPem)
      const leaf = new x509.X509Certificate(leafPem)

      // Root is self-signed
      expect(root.issuer).toBe(root.subject)

      // Services CA issued by root
      expect(intermediate.issuer).toBe(root.subject)

      // Leaf issued by Services CA
      expect(leaf.issuer).toBe(intermediate.subject)
    })

    test('SKI/AKI chain links correctly', () => {
      const root = new x509.X509Certificate(rootPem)
      const intermediate = new x509.X509Certificate(servicesPem)
      const leaf = new x509.X509Certificate(leafPem)

      const rootSki = root.getExtension(x509.SubjectKeyIdentifierExtension)
      const intermediateAki = intermediate.getExtension(x509.AuthorityKeyIdentifierExtension)
      const intermediateSki = intermediate.getExtension(x509.SubjectKeyIdentifierExtension)
      const leafAki = leaf.getExtension(x509.AuthorityKeyIdentifierExtension)

      // Intermediate AKI = Root SKI
      expect(intermediateAki!.keyId).toBe(rootSki!.keyId)

      // Leaf AKI = Intermediate SKI
      expect(leafAki!.keyId).toBe(intermediateSki!.keyId)

      // All SKIs are unique
      const leafSki = leaf.getExtension(x509.SubjectKeyIdentifierExtension)
      expect(rootSki!.keyId).not.toBe(intermediateSki!.keyId)
      expect(intermediateSki!.keyId).not.toBe(leafSki!.keyId)
    })

    test('chain validates via X509ChainBuilder', async () => {
      const root = new x509.X509Certificate(rootPem)
      const intermediate = new x509.X509Certificate(servicesPem)
      const leaf = new x509.X509Certificate(leafPem)

      const chain = new x509.X509ChainBuilder({
        certificates: [intermediate, root],
      })

      const items = await chain.build(leaf)
      // Chain should include: leaf -> intermediate -> root (3 certs)
      expect(items.length).toBe(3)
    })
  })
})
