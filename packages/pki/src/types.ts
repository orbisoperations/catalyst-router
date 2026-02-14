import { z } from 'zod'

// ----- Enums -----

/** Certificate type stored in the certificate store */
export type CertificateType = 'root-ca' | 'services-ca' | 'transport-ca' | 'end-entity'

/** Service types that can receive SVIDs */
export type ServiceType =
  | 'orchestrator'
  | 'auth'
  | 'node'
  | 'gateway'
  | 'envoy/app'
  | 'envoy/transport'

/** Certificate status in the store */
export type CertificateStatus = 'active' | 'superseded' | 'expired'

// ----- Certificate Record -----

/** Persisted certificate metadata. Stored in SQLite. */
export interface CertificateRecord {
  /** Unique serial number (hex string) */
  serial: string
  /** SHA-256 fingerprint of the DER-encoded certificate (base64url, no padding) */
  fingerprint: string
  /** Certificate type */
  type: CertificateType
  /** Subject Common Name */
  commonName: string
  /** SPIFFE ID URI SAN (null for CA certs) */
  spiffeId: string | null
  /** PEM-encoded certificate */
  certificatePem: string
  /** PEM-encoded encrypted private key (null for certs where we don't hold the key) */
  privateKeyPem: string | null
  /** Issuer serial number (null for self-signed root) */
  issuerSerial: string | null
  /** Not-before timestamp (ms since epoch) */
  notBefore: number
  /** Not-after timestamp (ms since epoch) */
  notAfter: number
  /** Current status */
  status: CertificateStatus
  /** Creation timestamp (ms since epoch) */
  createdAt: number
}

// ----- Deny List Record -----

/** A denied SPIFFE identity */
export interface DenyListEntry {
  /** SPIFFE ID that is denied */
  spiffeId: string
  /** Human-readable reason for denial */
  reason: string
  /** When the identity was denied (ms since epoch) */
  deniedAt: number
}

// ----- Store Interface -----

/** Interface for certificate metadata persistence. */
export interface ICertificateStore {
  // --- CA certificates ---

  /** Save a CA certificate record (root, services, or transport) */
  saveCaCertificate(record: CertificateRecord): Promise<void>

  /** Load a CA certificate by type. Returns the active one, or null. */
  loadCaCertificate(
    type: 'root-ca' | 'services-ca' | 'transport-ca'
  ): Promise<CertificateRecord | null>

  /** Load all CA certificates of a given type (active + retiring) */
  loadAllCaCertificates(
    type: 'root-ca' | 'services-ca' | 'transport-ca'
  ): Promise<CertificateRecord[]>

  // --- End-entity certificates ---

  /** Save an end-entity certificate record */
  saveEndEntityCertificate(record: CertificateRecord): Promise<void>

  /** Find a certificate by serial number */
  findBySerial(serial: string): Promise<CertificateRecord | null>

  /** Find a certificate by fingerprint */
  findByFingerprint(fingerprint: string): Promise<CertificateRecord | null>

  /** Find all active certificates for a SPIFFE ID */
  findBySpiffeId(spiffeId: string): Promise<CertificateRecord[]>

  /** List all active (non-expired) end-entity certificates */
  listActiveCertificates(): Promise<CertificateRecord[]>

  /** Mark a certificate as superseded (replaced by renewal) */
  markSuperseded(serial: string): Promise<void>

  // --- Deny list ---

  /** Add a SPIFFE ID to the deny list */
  denyIdentity(spiffeId: string, reason: string): Promise<void>

  /** Remove a SPIFFE ID from the deny list */
  allowIdentity(spiffeId: string): Promise<void>

  /** Check if a SPIFFE ID is denied */
  isDenied(spiffeId: string): Promise<boolean>

  /** List all denied identities */
  listDeniedIdentities(): Promise<DenyListEntry[]>

  // --- Maintenance ---

  /** Delete expired certificates older than the given cutoff (ms since epoch) */
  purgeExpired(cutoffMs: number): Promise<number>

  /** Count certificates by type and status */
  countCertificates(): Promise<
    { type: CertificateType; status: CertificateStatus; count: number }[]
  >
}

// ----- Signing Backend Interface -----

/**
 * Abstraction over the crypto operations needed to sign certificates and CSRs.
 * Phase 1: WebCrypto via @peculiar/x509.
 * Phase 2: Cloud KMS (AWS KMS, GCP Cloud KMS).
 */
export interface ISigningBackend {
  /** Generate a new ECDSA P-384 key pair. Returns the CryptoKeyPair. */
  generateKeyPair(): Promise<CryptoKeyPair>

  /**
   * Sign a certificate. The backend receives the signing parameters
   * and returns the signed certificate PEM.
   *
   * For cloud KMS backends, the privateKey parameter is ignored — the backend
   * signs using the KMS key referenced by its configuration.
   */
  signCertificate(params: SignCertificateParams): Promise<string>

  /** Export a CryptoKey to PEM format */
  exportPrivateKeyPem(key: CryptoKey): Promise<string>

  /** Import a PEM private key back to CryptoKey */
  importPrivateKeyPem(pem: string): Promise<CryptoKey>

  /** Export a CryptoKey public key to PEM */
  exportPublicKeyPem(key: CryptoKey): Promise<string>

  /** Compute SHA-256 fingerprint of a DER-encoded certificate (base64url, no padding) */
  computeFingerprint(certDer: ArrayBuffer): Promise<string>
}

/** Parameters for certificate signing */
export interface SignCertificateParams {
  /** Subject distinguished name (CN) */
  subjectCN: string
  /** Subject Alternative Names — SPIFFE URI */
  sanUri?: string
  /** Subject Alternative Names — DNS names */
  sanDns?: string[]
  /** The signing CA's private key (ignored by KMS backends) */
  signingKey: CryptoKey
  /** The signing CA's certificate PEM (for AKI extension). Empty string for self-signed. */
  signingCert: string
  /** The subject's public key */
  subjectPublicKey: CryptoKey
  /** Not-before date */
  notBefore: Date
  /** Not-after date */
  notAfter: Date
  /** Whether this is a CA certificate */
  isCa: boolean
  /** Path length constraint for CA certs (-1 for end-entity) */
  pathLenConstraint?: number
  /** Key usage flags */
  keyUsage: KeyUsageFlags
  /** Extended key usage OIDs */
  extKeyUsage?: ExtKeyUsage[]
  /** Name constraints (for intermediate CAs) */
  nameConstraints?: { permittedUris: string[] }
  /** Serial number (hex string). Auto-generated if not provided. */
  serialNumber?: string
}

/** Key usage flags matching X.509 key usage extension */
export interface KeyUsageFlags {
  digitalSignature?: boolean
  keyCertSign?: boolean
  crlSign?: boolean
}

/** Extended key usage identifiers */
export type ExtKeyUsage = 'serverAuth' | 'clientAuth'

// ----- CSR types -----

/** A parsed and validated CSR */
export interface ValidatedCSR {
  /** The raw PEM of the CSR */
  csrPem: string
  /** Extracted subject CN */
  subjectCN: string
  /** Extracted SPIFFE ID from the URI SAN */
  spiffeId: string
  /** Extracted DNS SANs */
  dnsSans: string[]
  /** The subject's public key */
  subjectPublicKey: CryptoKey
  /** Key algorithm (must be P-384 in Phase 1) */
  keyAlgorithm: string
}

/** Request to sign a CSR */
export interface SignCSRRequest {
  /** PEM-encoded CSR */
  csrPem: string
  /** Expected service type (validated against SPIFFE URI in CSR) */
  serviceType: ServiceType
  /** Node or instance ID (validated against SPIFFE URI in CSR) */
  instanceId: string
  /** Requested TTL in seconds. Capped at max SVID TTL. */
  ttlSeconds?: number
}

/** Result of signing a CSR */
export interface SignCSRResult {
  /** PEM-encoded signed certificate */
  certificatePem: string
  /** Certificate chain (intermediate + root, PEM-encoded) */
  chain: string[]
  /** Expiration timestamp (ISO 8601) */
  expiresAt: string
  /** Recommended renewal time (ISO 8601) — 50% of lifetime */
  renewAfter: string
  /** SHA-256 fingerprint of the certificate (base64url) */
  fingerprint: string
  /** Serial number (hex string) */
  serial: string
}

// ----- CA Bundle -----

/** The trust bundle returned by the CA bundle endpoint */
export interface CaBundleResponse {
  /** SPIFFE trust domain */
  trustDomain: string
  /** PEM certificates for services network trust (Services CA + Root CA) */
  servicesBundle: string[]
  /** PEM certificates for transport network trust (Transport CA + Root CA) */
  transportBundle: string[]
  /** Version string for caching (changes when bundle changes) */
  version: string
  /** Earliest CA expiry in the bundle (ISO 8601) */
  expiresAt: string
}

// ----- PKI Status -----

/** Health status of the PKI system */
export type PkiHealthStatus = 'healthy' | 'degraded' | 'uninitialized'

/** PKI status response */
export interface PkiStatusResponse {
  status: PkiHealthStatus
  trustDomain: string
  rootCa: CaStatusInfo | null
  servicesCa: CaStatusInfo | null
  transportCa: CaStatusInfo | null
  activeCertCount: number
  deniedIdentityCount: number
  warnings: string[]
}

/** Status info for a CA certificate */
export interface CaStatusInfo {
  fingerprint: string
  commonName: string
  algorithm: string
  expiresAt: string
  issuedCertCount: number
}

// ----- Zod Schemas for RPC -----

export const SignCSRRequestSchema = z.object({
  csrPem: z.string().min(1),
  serviceType: z.enum(['orchestrator', 'auth', 'node', 'gateway', 'envoy/app', 'envoy/transport']),
  instanceId: z.string().min(1),
  ttlSeconds: z.number().positive().optional(),
})

export const DenyIdentityRequestSchema = z.object({
  spiffeId: z.string().startsWith('spiffe://'),
  reason: z.string().min(1),
})

export const AllowIdentityRequestSchema = z.object({
  spiffeId: z.string().startsWith('spiffe://'),
})
