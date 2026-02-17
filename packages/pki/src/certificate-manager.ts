import * as x509 from '@peculiar/x509'
import type {
  ICertificateStore,
  ISigningBackend,
  CertificateRecord,
  SignCSRRequest,
  SignCSRResult,
  CaBundleResponse,
  PkiStatusResponse,
  CaStatusInfo,
  DenyListEntry,
  ExtKeyUsage,
} from './types.js'
import type { PkiConfig, PkiProviderConfig } from '@catalyst/config'
import { BunSqliteCertificateStore } from './store/sqlite-certificate-store.js'
import { WebCryptoSigningBackend } from './signing/webcrypto-signing-backend.js'
import { buildSpiffeId } from './spiffe.js'

// Set the @peculiar/x509 crypto provider to use Bun's SubtleCrypto
x509.cryptoProvider.set(crypto)

/** Configuration for CertificateManager */
export interface CertificateManagerConfig {
  /** SPIFFE trust domain (e.g., 'catalyst.example.com') */
  trustDomain?: string
  /** Default SVID TTL in seconds (default: 3600 = 1 hour) */
  svidTtlSeconds?: number
  /** Maximum SVID TTL in seconds (hard cap: 86400 = 24 hours) */
  maxSvidTtlSeconds?: number
}

/** The 24-hour hard cap from ADR 0011 Section 5 */
const MAX_SVID_TTL_SECONDS = 86400
const DEFAULT_SVID_TTL_SECONDS = 3600
const DEFAULT_TRUST_DOMAIN = 'catalyst.example.com'

/** Name constraints for the Services CA — permits core service SPIFFE URIs */
const SERVICES_CA_PERMITTED_URIS = [
  'spiffe://TRUST_DOMAIN/orchestrator/',
  'spiffe://TRUST_DOMAIN/auth/',
  'spiffe://TRUST_DOMAIN/node/',
  'spiffe://TRUST_DOMAIN/gateway/',
]

/** Name constraints for the Transport CA — permits envoy SPIFFE URIs */
const TRANSPORT_CA_PERMITTED_URIS = ['spiffe://TRUST_DOMAIN/envoy/']

/**
 * Batteries-included facade for PKI certificate lifecycle management.
 *
 * Wires together certificate storage and a signing backend behind a single
 * config-driven API. Mirrors `JWTTokenFactory` from
 * `packages/authorization/src/jwt/jwt-token-factory.ts`.
 *
 * @example
 * ```typescript
 * // Production
 * const manager = new CertificateManager(store, backend, { trustDomain: 'mesh.example.com' })
 * await manager.initialize()
 *
 * // Testing — ephemeral in-memory
 * const manager = CertificateManager.ephemeral()
 * await manager.initialize()
 * ```
 */
export class CertificateManager {
  private readonly store: ICertificateStore
  private readonly backend: ISigningBackend
  private readonly trustDomain: string
  private readonly svidTtlSeconds: number
  private readonly maxSvidTtlSeconds: number
  private initialized = false

  constructor(
    store: ICertificateStore,
    backend: ISigningBackend,
    config?: CertificateManagerConfig
  ) {
    this.store = store
    this.backend = backend
    this.trustDomain = config?.trustDomain ?? DEFAULT_TRUST_DOMAIN
    this.svidTtlSeconds = config?.svidTtlSeconds ?? DEFAULT_SVID_TTL_SECONDS
    this.maxSvidTtlSeconds = Math.min(
      config?.maxSvidTtlSeconds ?? MAX_SVID_TTL_SECONDS,
      MAX_SVID_TTL_SECONDS
    )
  }

  /**
   * Create an ephemeral CertificateManager with in-memory SQLite.
   * Useful for testing — no files created on disk.
   *
   * Pattern: Mirrors JWTTokenFactory.ephemeral()
   */
  static ephemeral(config?: {
    trustDomain?: string
    svidTtlSeconds?: number
    maxSvidTtlSeconds?: number
  }): CertificateManager {
    return new CertificateManager(
      new BunSqliteCertificateStore(':memory:'),
      new WebCryptoSigningBackend(),
      config
    )
  }

  /**
   * Create a CertificateManager from a validated PkiConfig.
   *
   * Supports:
   * - `local`: WebCrypto signing with SQLite persistence (file or in-memory)
   * - `gcloud-kms` / `aws-kms`: Throws until Phase 2 backends are implemented
   *
   * @example
   * ```typescript
   * const config = CatalystConfigSchema.parse(rawConfig)
   * const manager = CertificateManager.fromConfig(config.auth!.pki!)
   * await manager.initialize()
   * ```
   */
  static fromConfig(config: PkiConfig): CertificateManager {
    const store = CertificateManager.createStore(config.provider)
    const backend = CertificateManager.createBackend(config.provider)

    return new CertificateManager(store, backend, {
      trustDomain: config.trustDomain,
      svidTtlSeconds: config.svidTtlSeconds,
      maxSvidTtlSeconds: config.maxSvidTtlSeconds,
    })
  }

  private static createStore(provider: PkiProviderConfig): ICertificateStore {
    switch (provider.type) {
      case 'local': {
        const dbPath = provider.persistent ? provider.certsDb : ':memory:'
        return new BunSqliteCertificateStore(dbPath)
      }
      case 'gcloud-kms':
        throw new Error(
          `PKI provider 'gcloud-kms' is not yet implemented. Use 'local' for Phase 1.`
        )
      case 'aws-kms':
        throw new Error(`PKI provider 'aws-kms' is not yet implemented. Use 'local' for Phase 1.`)
    }
  }

  private static createBackend(provider: PkiProviderConfig): ISigningBackend {
    switch (provider.type) {
      case 'local':
        return new WebCryptoSigningBackend()
      case 'gcloud-kms':
        throw new Error(
          `PKI provider 'gcloud-kms' is not yet implemented. Use 'local' for Phase 1.`
        )
      case 'aws-kms':
        throw new Error(`PKI provider 'aws-kms' is not yet implemented. Use 'local' for Phase 1.`)
    }
  }

  /** Whether the CA hierarchy has been initialized */
  isInitialized(): boolean {
    return this.initialized
  }

  // ===== CA Lifecycle =====

  /**
   * Initialize the full CA hierarchy (root + services CA + transport CA).
   * If a root CA already exists, loads it and skips generation.
   * Idempotent — safe to call multiple times.
   */
  async initialize(): Promise<{
    rootFingerprint: string
    servicesCaFingerprint: string
    transportCaFingerprint: string
  }> {
    // Check for existing root CA — resume from stored state
    const existingRoot = await this.store.loadCaCertificate('root-ca')
    if (existingRoot) {
      const existingServices = await this.store.loadCaCertificate('services-ca')
      const existingTransport = await this.store.loadCaCertificate('transport-ca')
      if (!existingServices || !existingTransport) {
        throw new Error('Corrupt CA state: root exists but intermediates missing')
      }
      this.initialized = true
      return {
        rootFingerprint: existingRoot.fingerprint,
        servicesCaFingerprint: existingServices.fingerprint,
        transportCaFingerprint: existingTransport.fingerprint,
      }
    }

    // Generate Root CA (self-signed, pathlen:1, 10-year validity)
    const rootKeyPair = await this.backend.generateKeyPair()
    const now = new Date()
    const rootNotAfter = new Date(now.getTime() + 10 * 365.25 * 24 * 60 * 60 * 1000)

    const rootCertPem = await this.backend.signCertificate({
      subjectCN: 'Catalyst Root CA',
      signingKey: rootKeyPair.privateKey,
      signingCert: '', // self-signed
      subjectPublicKey: rootKeyPair.publicKey,
      notBefore: now,
      notAfter: rootNotAfter,
      isCa: true,
      pathLenConstraint: 1,
      keyUsage: { keyCertSign: true, crlSign: true },
    })

    const rootCert = new x509.X509Certificate(rootCertPem)
    const rootFingerprint = await this.backend.computeFingerprint(rootCert.rawData)
    const rootSerial = rootCert.serialNumber
    const rootPrivateKeyPem = await this.backend.exportPrivateKeyPem(rootKeyPair.privateKey)

    await this.store.saveCaCertificate({
      serial: rootSerial,
      fingerprint: rootFingerprint,
      type: 'root-ca',
      commonName: 'Catalyst Root CA',
      spiffeId: null,
      certificatePem: rootCertPem,
      privateKeyPem: rootPrivateKeyPem,
      issuerSerial: null,
      notBefore: now.getTime(),
      notAfter: rootNotAfter.getTime(),
      status: 'active',
      createdAt: now.getTime(),
    })

    // Generate Services CA (signed by root, pathlen:0, 5-year validity)
    const servicesCaFingerprint = await this.generateIntermediateCa({
      commonName: 'Catalyst Services CA',
      caType: 'services-ca',
      rootKeyPair,
      rootCertPem,
      rootSerial,
      now,
      permittedUris: SERVICES_CA_PERMITTED_URIS.map((u) =>
        u.replace('TRUST_DOMAIN', this.trustDomain)
      ),
    })

    // Generate Transport CA (signed by root, pathlen:0, 5-year validity)
    const transportCaFingerprint = await this.generateIntermediateCa({
      commonName: 'Catalyst Transport CA',
      caType: 'transport-ca',
      rootKeyPair,
      rootCertPem,
      rootSerial,
      now,
      permittedUris: TRANSPORT_CA_PERMITTED_URIS.map((u) =>
        u.replace('TRUST_DOMAIN', this.trustDomain)
      ),
    })

    this.initialized = true
    return { rootFingerprint, servicesCaFingerprint, transportCaFingerprint }
  }

  private async generateIntermediateCa(params: {
    commonName: string
    caType: 'services-ca' | 'transport-ca'
    rootKeyPair: CryptoKeyPair
    rootCertPem: string
    rootSerial: string
    now: Date
    permittedUris: string[]
  }): Promise<string> {
    const keyPair = await this.backend.generateKeyPair()
    const notAfter = new Date(params.now.getTime() + 5 * 365.25 * 24 * 60 * 60 * 1000)

    const certPem = await this.backend.signCertificate({
      subjectCN: params.commonName,
      signingKey: params.rootKeyPair.privateKey,
      signingCert: params.rootCertPem,
      subjectPublicKey: keyPair.publicKey,
      notBefore: params.now,
      notAfter,
      isCa: true,
      pathLenConstraint: 0,
      keyUsage: { keyCertSign: true, crlSign: true },
      nameConstraints: { permittedUris: params.permittedUris },
    })

    const cert = new x509.X509Certificate(certPem)
    const fingerprint = await this.backend.computeFingerprint(cert.rawData)
    const privateKeyPem = await this.backend.exportPrivateKeyPem(keyPair.privateKey)

    await this.store.saveCaCertificate({
      serial: cert.serialNumber,
      fingerprint,
      type: params.caType,
      commonName: params.commonName,
      spiffeId: null,
      certificatePem: certPem,
      privateKeyPem,
      issuerSerial: params.rootSerial,
      notBefore: params.now.getTime(),
      notAfter: notAfter.getTime(),
      status: 'active',
      createdAt: params.now.getTime(),
    })

    return fingerprint
  }

  // ===== CSR Signing =====

  /**
   * Validate and sign a CSR, producing an end-entity SVID.
   *
   * @throws Error if identity is denied, CSR is invalid, or CA is not initialized
   */
  async signCSR(request: SignCSRRequest): Promise<SignCSRResult> {
    if (!this.initialized) throw new Error('CA not initialized')

    // Build expected SPIFFE ID
    const expectedSpiffeId = buildSpiffeId(
      this.trustDomain,
      request.serviceType,
      request.instanceId
    )

    // Check deny list before issuing
    const denied = await this.store.isDenied(expectedSpiffeId)
    if (denied) throw new Error(`Identity denied: ${expectedSpiffeId}`)

    // Parse and validate CSR
    const csr = new x509.Pkcs10CertificateRequest(request.csrPem)

    // Verify CSR self-signature (proof-of-possession)
    const csrValid = await csr.verify()
    if (!csrValid) throw new Error('CSR signature verification failed')

    // Extract subject public key
    const subjectPublicKey = await csr.publicKey.export()

    // Validate key algorithm is P-384
    const keyAlg = subjectPublicKey.algorithm as EcKeyAlgorithm
    if (keyAlg.namedCurve !== 'P-384') {
      throw new Error(`Key algorithm must be P-384, got ${keyAlg.namedCurve}`)
    }

    // Determine which CA signs this cert
    const isTransport = request.serviceType.startsWith('envoy/')
    const caType = isTransport ? 'transport-ca' : 'services-ca'
    const ca = await this.store.loadCaCertificate(caType)
    if (!ca || !ca.privateKeyPem) {
      throw new Error(`Signing CA not available: ${caType}`)
    }

    // Compute TTL (requested, capped at max)
    const ttl = Math.min(request.ttlSeconds ?? this.svidTtlSeconds, this.maxSvidTtlSeconds)
    const notBefore = new Date()
    const notAfter = new Date(notBefore.getTime() + ttl * 1000)

    // Determine EKU based on service type
    const extKeyUsage = this.getExtKeyUsage(request.serviceType)

    // Sign the certificate
    const caPrivateKey = await this.backend.importPrivateKeyPem(ca.privateKeyPem)
    const certPem = await this.backend.signCertificate({
      subjectCN: request.instanceId,
      sanUri: expectedSpiffeId,
      sanDns: [request.instanceId],
      signingKey: caPrivateKey,
      signingCert: ca.certificatePem,
      subjectPublicKey,
      notBefore,
      notAfter,
      isCa: false,
      keyUsage: { digitalSignature: true },
      extKeyUsage,
    })

    // Compute fingerprint and serial
    const cert = new x509.X509Certificate(certPem)
    const fingerprint = await this.backend.computeFingerprint(cert.rawData)
    const serial = cert.serialNumber

    // Store the end-entity certificate
    await this.store.saveEndEntityCertificate({
      serial,
      fingerprint,
      type: 'end-entity',
      commonName: request.instanceId,
      spiffeId: expectedSpiffeId,
      certificatePem: certPem,
      privateKeyPem: null, // we don't hold the client's private key
      issuerSerial: ca.serial,
      notBefore: notBefore.getTime(),
      notAfter: notAfter.getTime(),
      status: 'active',
      createdAt: Date.now(),
    })

    // Build chain: intermediate CA + root CA
    const rootCa = await this.store.loadCaCertificate('root-ca')
    if (!rootCa) throw new Error('Root CA not found')

    return {
      certificatePem: certPem,
      chain: [ca.certificatePem, rootCa.certificatePem],
      expiresAt: notAfter.toISOString(),
      // renewAfter: 50% of lifetime, relative to notBefore (per PKI review corrections)
      renewAfter: new Date(notBefore.getTime() + ttl * 500).toISOString(),
      fingerprint,
      serial,
    }
  }

  private getExtKeyUsage(serviceType: string): ExtKeyUsage[] {
    // Gateway is server-only (ADR 0011 Section 3.7)
    if (serviceType === 'gateway') return ['serverAuth']
    // All others are both server and client
    return ['serverAuth', 'clientAuth']
  }

  // ===== CA Bundle =====

  /** Get the trust bundle for distribution. */
  async getCaBundle(): Promise<CaBundleResponse> {
    const root = await this.store.loadCaCertificate('root-ca')
    if (!root) throw new Error('CA not initialized')

    const servicesCas = await this.store.loadAllCaCertificates('services-ca')
    const transportCas = await this.store.loadAllCaCertificates('transport-ca')

    return {
      trustDomain: this.trustDomain,
      servicesBundle: [...servicesCas.map((c) => c.certificatePem), root.certificatePem],
      transportBundle: [...transportCas.map((c) => c.certificatePem), root.certificatePem],
      version: `v${root.fingerprint.slice(0, 8)}`,
      expiresAt: new Date(
        Math.min(...servicesCas.map((c) => c.notAfter), ...transportCas.map((c) => c.notAfter))
      ).toISOString(),
    }
  }

  // ===== Deny List =====

  /** Deny a SPIFFE identity. Returns info about existing certs that will expire naturally. */
  async denyIdentity(
    spiffeId: string,
    reason: string
  ): Promise<{ expiringCerts: { serial: string; expiresAt: string }[] }> {
    await this.store.denyIdentity(spiffeId, reason)
    const certs = await this.store.findBySpiffeId(spiffeId)
    return {
      expiringCerts: certs.map((c) => ({
        serial: c.serial,
        expiresAt: new Date(c.notAfter).toISOString(),
      })),
    }
  }

  /** Re-enable a denied identity. */
  async allowIdentity(spiffeId: string): Promise<void> {
    await this.store.allowIdentity(spiffeId)
  }

  /** List all denied identities. */
  async listDeniedIdentities(): Promise<DenyListEntry[]> {
    return this.store.listDeniedIdentities()
  }

  // ===== Status =====

  /** Get PKI system status. */
  async getStatus(): Promise<PkiStatusResponse> {
    const root = await this.store.loadCaCertificate('root-ca')
    if (!root) {
      return {
        status: 'uninitialized',
        trustDomain: this.trustDomain,
        rootCa: null,
        servicesCa: null,
        transportCa: null,
        activeCertCount: 0,
        deniedIdentityCount: 0,
        warnings: [],
      }
    }

    const servicesCa = await this.store.loadCaCertificate('services-ca')
    const transportCa = await this.store.loadCaCertificate('transport-ca')
    const activeCerts = await this.store.listActiveCertificates()
    const denied = await this.store.listDeniedIdentities()
    const counts = await this.store.countCertificates()

    const warnings: string[] = []
    const now = Date.now()
    const thirtyDays = 30 * 24 * 60 * 60 * 1000

    // Check for CA certificates approaching expiry
    if (root.notAfter - now < thirtyDays) {
      warnings.push('Root CA expires within 30 days')
    }
    if (servicesCa && servicesCa.notAfter - now < thirtyDays) {
      warnings.push('Services CA expires within 30 days')
    }
    if (transportCa && transportCa.notAfter - now < thirtyDays) {
      warnings.push('Transport CA expires within 30 days')
    }

    const status = warnings.length > 0 ? 'degraded' : 'healthy'

    const buildCaInfo = (ca: CertificateRecord): CaStatusInfo => {
      const issuedCount = counts
        .filter((c) => c.type === 'end-entity' && c.status === 'active')
        .reduce((sum, c) => sum + c.count, 0)
      return {
        fingerprint: ca.fingerprint,
        commonName: ca.commonName,
        algorithm: 'ECDSA P-384',
        expiresAt: new Date(ca.notAfter).toISOString(),
        issuedCertCount: issuedCount,
      }
    }

    return {
      status,
      trustDomain: this.trustDomain,
      rootCa: buildCaInfo(root),
      servicesCa: servicesCa ? buildCaInfo(servicesCa) : null,
      transportCa: transportCa ? buildCaInfo(transportCa) : null,
      activeCertCount: activeCerts.length,
      deniedIdentityCount: denied.length,
      warnings,
    }
  }

  // ===== Maintenance =====

  /** Purge expired certificates. Keeps recently expired for audit trail (24h grace). */
  async purgeExpired(): Promise<number> {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return this.store.purgeExpired(cutoff)
  }

  /** Cleanup. No-op for now but matches the lifecycle pattern. */
  async shutdown(): Promise<void> {
    // Reserved for future cleanup (e.g., releasing KMS sessions)
  }

  // ===== Accessors =====

  /** Access the underlying certificate store */
  getStore(): ICertificateStore {
    return this.store
  }

  /** Access the underlying signing backend */
  getBackend(): ISigningBackend {
    return this.backend
  }

  /** Get the configured trust domain */
  getTrustDomain(): string {
    return this.trustDomain
  }
}
