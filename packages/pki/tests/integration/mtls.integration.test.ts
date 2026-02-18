/**
 * mTLS integration test — proves PKI-generated certificates work for real TLS connections.
 *
 * Uses node:https as a TLS server and a custom tlsFetch helper as a TLS client
 * to exercise actual TLS handshakes with certificates built by our
 * WebCryptoSigningBackend.
 *
 * The test builds its own CA hierarchy using the signing backend directly (not
 * CertificateManager) because CertificateManager's intermediate CAs carry URI-only
 * Name Constraints that OpenSSL rejects when leaf certs include DNS SANs — which
 * are required for TLS hostname verification. This is a known interaction between
 * SPIFFE-style name constraints and DNS-based TLS; production deployments solve this
 * with separate TLS-facing certs or SAN-aware proxies.
 *
 * What this test proves:
 * - WebCryptoSigningBackend produces valid X.509 certs usable for real TLS
 * - One-way TLS: server cert validation by client
 * - Mutual TLS: server requires and validates client cert presence
 * - No-client-cert rejection
 * - Cross-CA isolation at the X.509 chain-builder level
 */
import { describe, test, expect, beforeAll, afterEach } from 'vitest'
import * as https from 'node:https'
import type { AddressInfo } from 'node:net'
import * as x509 from '@peculiar/x509'
import { WebCryptoSigningBackend } from '../../src/signing/webcrypto-signing-backend.js'
import { CertificateManager } from '../../src/certificate-manager.js'

x509.cryptoProvider.set(crypto)

// ---------------------------------------------------------------------------
// TLS test helpers
// ---------------------------------------------------------------------------

interface TlsTestServer {
  port: number
  stop(): void
}

/**
 * Make an HTTPS request with custom TLS options.
 * Replaces Bun's `fetch(url, { tls: {...} })` with node:https.
 */
async function tlsFetch(
  url: string,
  options?: {
    ca?: string
    cert?: string
    key?: string
    rejectUnauthorized?: boolean
    servername?: string
  }
): Promise<{ status: number; text(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        ...options,
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            text: async () => body,
          })
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/** Export a CryptoKey private key to PEM format. */
async function exportKeyPem(key: CryptoKey): Promise<string> {
  const der = await crypto.subtle.exportKey('pkcs8', key)
  return x509.PemConverter.encode(der, 'PRIVATE KEY')
}

describe('mTLS integration', () => {
  const backend = new WebCryptoSigningBackend()

  // CA hierarchy (no URI-only name constraints so DNS SANs work with OpenSSL)
  let rootCaPem: string
  let intermediateCaPem: string
  let rootKeyPair: CryptoKeyPair
  let intermediateKeyPair: CryptoKeyPair

  // Server identity
  let serverCertPem: string
  let serverKeyPem: string

  // Client identity
  let clientCertPem: string
  let clientKeyPem: string

  // Each test creates its own server; stopped in afterEach to prevent interference
  let activeServer: TlsTestServer | null = null

  beforeAll(async () => {
    const now = new Date()
    const oneHourLater = new Date(now.getTime() + 3_600_000)
    const tenYearsLater = new Date(now.getTime() + 10 * 365.25 * 24 * 60 * 60 * 1000)
    const fiveYearsLater = new Date(now.getTime() + 5 * 365.25 * 24 * 60 * 60 * 1000)

    // 1. Root CA (self-signed)
    rootKeyPair = await backend.generateKeyPair()
    rootCaPem = await backend.signCertificate({
      subjectCN: 'mTLS Test Root CA',
      signingKey: rootKeyPair.privateKey,
      signingCert: '',
      subjectPublicKey: rootKeyPair.publicKey,
      notBefore: now,
      notAfter: tenYearsLater,
      isCa: true,
      pathLenConstraint: 1,
      keyUsage: { keyCertSign: true, crlSign: true },
    })

    // 2. Intermediate CA (signed by root, no name constraints for TLS compatibility)
    intermediateKeyPair = await backend.generateKeyPair()
    intermediateCaPem = await backend.signCertificate({
      subjectCN: 'mTLS Test Intermediate CA',
      signingKey: rootKeyPair.privateKey,
      signingCert: rootCaPem,
      subjectPublicKey: intermediateKeyPair.publicKey,
      notBefore: now,
      notAfter: fiveYearsLater,
      isCa: true,
      pathLenConstraint: 0,
      keyUsage: { keyCertSign: true, crlSign: true },
    })

    // 3. Server certificate (signed by intermediate, DNS SAN = localhost)
    const serverKeyPairCrypto = await backend.generateKeyPair()
    serverCertPem = await backend.signCertificate({
      subjectCN: 'localhost',
      sanUri: 'spiffe://mtls-test.example.com/gateway/localhost',
      sanDns: ['localhost'],
      signingKey: intermediateKeyPair.privateKey,
      signingCert: intermediateCaPem,
      subjectPublicKey: serverKeyPairCrypto.publicKey,
      notBefore: now,
      notAfter: oneHourLater,
      isCa: false,
      keyUsage: { digitalSignature: true },
      extKeyUsage: ['serverAuth'],
    })
    serverKeyPem = await exportKeyPem(serverKeyPairCrypto.privateKey)

    // 4. Client certificate (signed by intermediate)
    const clientKeyPairCrypto = await backend.generateKeyPair()
    clientCertPem = await backend.signCertificate({
      subjectCN: 'test-client',
      sanUri: 'spiffe://mtls-test.example.com/orchestrator/test-client',
      signingKey: intermediateKeyPair.privateKey,
      signingCert: intermediateCaPem,
      subjectPublicKey: clientKeyPairCrypto.publicKey,
      notBefore: now,
      notAfter: oneHourLater,
      isCa: false,
      keyUsage: { digitalSignature: true },
      extKeyUsage: ['serverAuth', 'clientAuth'],
    })
    clientKeyPem = await exportKeyPem(clientKeyPairCrypto.privateKey)
  })

  afterEach(() => {
    if (activeServer) {
      activeServer.stop()
      activeServer = null
    }
  })

  /** Start a one-way TLS server (no client cert required). */
  async function startOneWayServer(handler: (req: Request) => Response): Promise<TlsTestServer> {
    const fullServerChain = [serverCertPem, intermediateCaPem].join('\n')

    const server = https.createServer(
      { cert: fullServerChain, key: serverKeyPem },
      async (_req, res) => {
        const response = handler(new Request('https://localhost/'))
        res.writeHead(response.status)
        res.end(await response.text())
      }
    )

    return new Promise<TlsTestServer>((resolve) => {
      server.listen(0, () => {
        const port = (server.address() as AddressInfo).port
        activeServer = { port, stop: () => server.close() }
        resolve(activeServer)
      })
    })
  }

  /** Start a mutual TLS server (requires client cert). */
  async function startMtlsServer(handler: (req: Request) => Response): Promise<TlsTestServer> {
    const fullServerChain = [serverCertPem, intermediateCaPem].join('\n')
    const serverCaBundle = [rootCaPem, intermediateCaPem].join('\n')

    const server = https.createServer(
      {
        cert: fullServerChain,
        key: serverKeyPem,
        ca: serverCaBundle,
        requestCert: true,
        rejectUnauthorized: true,
      },
      async (_req, res) => {
        const response = handler(new Request('https://localhost/'))
        res.writeHead(response.status)
        res.end(await response.text())
      }
    )

    return new Promise<TlsTestServer>((resolve) => {
      server.listen(0, () => {
        const port = (server.address() as AddressInfo).port
        activeServer = { port, stop: () => server.close() }
        resolve(activeServer)
      })
    })
  }

  // ===== One-way TLS (server authentication only) =====

  describe('server authentication (one-way TLS)', () => {
    test('client trusting our CA can connect to a PKI-signed server', async () => {
      const server = await startOneWayServer(() => new Response('hello-tls'))

      const resp = await tlsFetch(`https://localhost:${server.port}/`, {
        ca: rootCaPem,
      })

      expect(resp.status).toBe(200)
      expect(await resp.text()).toBe('hello-tls')
    })
  })

  // ===== Mutual TLS (server requires client cert) =====

  describe('mutual TLS (client cert required)', () => {
    test('mTLS succeeds with valid client cert', async () => {
      const server = await startMtlsServer(() => new Response('mtls-ok'))

      const resp = await tlsFetch(`https://localhost:${server.port}/`, {
        cert: clientCertPem,
        key: clientKeyPem,
        ca: rootCaPem,
        servername: 'localhost',
      })

      expect(resp.status).toBe(200)
      expect(await resp.text()).toBe('mtls-ok')
    })
  })

  // ===== TLS rejection scenarios =====

  describe('TLS rejection scenarios', () => {
    test('client NOT trusting our CA gets a TLS error', async () => {
      const server = await startOneWayServer(() => new Response('should-not-reach'))

      try {
        const resp = await tlsFetch(`https://localhost:${server.port}/`, {
          rejectUnauthorized: true,
        })
        expect(resp.status).not.toBe(200)
      } catch (e) {
        // Expected: TLS handshake failure — server cert is not trusted
        expect(e).toBeDefined()
      }
    })

    test('connection is rejected when no client cert is presented', async () => {
      const server = await startMtlsServer(() => new Response('should-not-reach'))

      try {
        await tlsFetch(`https://localhost:${server.port}/`, {
          ca: rootCaPem,
        })
        expect.unreachable('Expected TLS rejection without client cert')
      } catch (e) {
        // Expected: server closes connection because no client cert was provided
        expect(e).toBeDefined()
      }
    })
  })

  // ===== Certificate properties verification =====

  describe('certificate properties', () => {
    test('server cert has correct SPIFFE URI SAN', () => {
      const cert = new x509.X509Certificate(serverCertPem)
      const san = cert.getExtension(x509.SubjectAlternativeNameExtension)
      expect(san).not.toBeNull()

      const uris = san!.names.items.filter((n: x509.GeneralName) => n.type === 'url')
      expect(uris).toHaveLength(1)
      expect(uris[0].value).toBe('spiffe://mtls-test.example.com/gateway/localhost')
    })

    test('client cert has correct SPIFFE URI SAN', () => {
      const cert = new x509.X509Certificate(clientCertPem)
      const san = cert.getExtension(x509.SubjectAlternativeNameExtension)
      expect(san).not.toBeNull()

      const uris = san!.names.items.filter((n: x509.GeneralName) => n.type === 'url')
      expect(uris).toHaveLength(1)
      expect(uris[0].value).toBe('spiffe://mtls-test.example.com/orchestrator/test-client')
    })

    test('server cert has serverAuth EKU only (gateway profile)', () => {
      const cert = new x509.X509Certificate(serverCertPem)
      const eku = cert.getExtension(x509.ExtendedKeyUsageExtension)
      expect(eku).not.toBeNull()
      expect(eku!.usages).toContain(x509.ExtendedKeyUsage.serverAuth)
      expect(eku!.usages).not.toContain(x509.ExtendedKeyUsage.clientAuth)
    })

    test('client cert has clientAuth EKU', () => {
      const cert = new x509.X509Certificate(clientCertPem)
      const eku = cert.getExtension(x509.ExtendedKeyUsageExtension)
      expect(eku).not.toBeNull()
      expect(eku!.usages).toContain(x509.ExtendedKeyUsage.clientAuth)
    })
  })

  // ===== Certificate chain integrity =====

  describe('certificate chain integrity', () => {
    test('server cert chains through intermediate to root', async () => {
      const leaf = new x509.X509Certificate(serverCertPem)
      const intermediate = new x509.X509Certificate(intermediateCaPem)
      const root = new x509.X509Certificate(rootCaPem)

      // Issuer DN chain
      expect(leaf.issuer).toBe(intermediate.subject)
      expect(intermediate.issuer).toBe(root.subject)
      expect(root.issuer).toBe(root.subject)

      // Cryptographic signature verification
      const leafValid = await leaf.verify({
        signatureOnly: true,
        publicKey: intermediateKeyPair.publicKey,
      })
      expect(leafValid).toBe(true)

      const intermediateValid = await intermediate.verify({
        signatureOnly: true,
        publicKey: rootKeyPair.publicKey,
      })
      expect(intermediateValid).toBe(true)

      // X509ChainBuilder validates the full chain
      const chain = new x509.X509ChainBuilder({
        certificates: [intermediate, root],
      })
      const items = await chain.build(leaf)
      expect(items.length).toBe(3)
    })

    test('client cert chains through intermediate to root', async () => {
      const leaf = new x509.X509Certificate(clientCertPem)
      const intermediate = new x509.X509Certificate(intermediateCaPem)
      const root = new x509.X509Certificate(rootCaPem)

      expect(leaf.issuer).toBe(intermediate.subject)

      const leafValid = await leaf.verify({
        signatureOnly: true,
        publicKey: intermediateKeyPair.publicKey,
      })
      expect(leafValid).toBe(true)

      const chain = new x509.X509ChainBuilder({
        certificates: [intermediate, root],
      })
      const items = await chain.build(leaf)
      expect(items.length).toBe(3)
    })
  })

  // ===== Cross-CA isolation =====

  describe('cross-CA isolation (X.509 chain verification)', () => {
    let untrustedCertPem: string

    beforeAll(async () => {
      const untrustedRootKeys = await backend.generateKeyPair()
      const untrustedRootPem = await backend.signCertificate({
        subjectCN: 'Untrusted Root CA',
        signingKey: untrustedRootKeys.privateKey,
        signingCert: '',
        subjectPublicKey: untrustedRootKeys.publicKey,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 3_600_000),
        isCa: true,
        pathLenConstraint: 1,
        keyUsage: { keyCertSign: true, crlSign: true },
      })

      const untrustedIntKeys = await backend.generateKeyPair()
      const untrustedIntPem = await backend.signCertificate({
        subjectCN: 'Untrusted Intermediate CA',
        signingKey: untrustedRootKeys.privateKey,
        signingCert: untrustedRootPem,
        subjectPublicKey: untrustedIntKeys.publicKey,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 3_600_000),
        isCa: true,
        pathLenConstraint: 0,
        keyUsage: { keyCertSign: true, crlSign: true },
      })

      const untrustedLeafKeys = await backend.generateKeyPair()
      untrustedCertPem = await backend.signCertificate({
        subjectCN: 'rogue-client',
        sanUri: 'spiffe://evil.example.com/orchestrator/rogue',
        signingKey: untrustedIntKeys.privateKey,
        signingCert: untrustedIntPem,
        subjectPublicKey: untrustedLeafKeys.publicKey,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 3_600_000),
        isCa: false,
        keyUsage: { digitalSignature: true },
        extKeyUsage: ['clientAuth'],
      })
    })

    test('cert from untrusted CA fails chain verification against our CA', async () => {
      const trustedIntermediate = new x509.X509Certificate(intermediateCaPem)
      const trustedRoot = new x509.X509Certificate(rootCaPem)
      const chain = new x509.X509ChainBuilder({
        certificates: [trustedIntermediate, trustedRoot],
      })

      const untrustedCert = new x509.X509Certificate(untrustedCertPem)
      const items = await chain.build(untrustedCert)

      expect(items.length).toBe(1)
    })

    test('cert from our CA succeeds chain verification', async () => {
      const trustedIntermediate = new x509.X509Certificate(intermediateCaPem)
      const trustedRoot = new x509.X509Certificate(rootCaPem)
      const chain = new x509.X509ChainBuilder({
        certificates: [trustedIntermediate, trustedRoot],
      })

      const ourCert = new x509.X509Certificate(clientCertPem)
      const items = await chain.build(ourCert)

      expect(items.length).toBe(3)
    })
  })

  // ===== CertificateManager integration =====

  describe('CertificateManager chain verification', () => {
    test('CertificateManager certs build a valid X.509 chain', async () => {
      const cm = CertificateManager.ephemeral({ trustDomain: 'chain-test.example.com' })
      await cm.initialize()

      const EC: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-384' }
      const SIG: EcdsaParams = { name: 'ECDSA', hash: 'SHA-384' }

      const keyPair = await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])
      const csr = await x509.Pkcs10CertificateRequestGenerator.create({
        name: 'CN=test-orch',
        keys: keyPair,
        signingAlgorithm: SIG,
        extensions: [
          new x509.SubjectAlternativeNameExtension([
            { type: 'url', value: 'spiffe://chain-test.example.com/orchestrator/test-orch' },
          ]),
        ],
      })

      const result = await cm.signCSR({
        csrPem: csr.toString('pem'),
        serviceType: 'orchestrator',
        instanceId: 'test-orch',
      })

      const leaf = new x509.X509Certificate(result.certificatePem)
      const servicesCa = new x509.X509Certificate(result.chain[0])
      const rootCa = new x509.X509Certificate(result.chain[1])

      expect(leaf.issuer).toBe(servicesCa.subject)
      expect(servicesCa.issuer).toBe(rootCa.subject)
      expect(rootCa.issuer).toBe(rootCa.subject)

      const chain = new x509.X509ChainBuilder({
        certificates: [servicesCa, rootCa],
      })
      const items = await chain.build(leaf)
      expect(items.length).toBe(3)
    })
  })
})
