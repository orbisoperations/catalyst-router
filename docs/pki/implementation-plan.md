# PKI Certificate Manager — Implementation Plan

This document is the file-by-file implementation plan for the Catalyst PKI
certificate manager. It covers the `packages/pki` package, its integration
into the auth service, and the progressive RPC API exposed through
`AuthRpcServer`.

**Reference documents:**

- [ADR 0011: PKI Hierarchy and Certificate Profiles](../adr/0011-pki-hierarchy-and-certificate-profiles.md)
- [Interaction Flows](interaction-flows.md)
- [Operations Guide](operations-guide.md)

**Implementation order:** Each step is testable independently. A developer
can implement steps 1-4 without the auth service running.

---

## Step 1: Package Setup + Core Types

### 1.1 `packages/pki/package.json`

New package. Follows `packages/authorization/package.json` conventions.

```json
{
  "name": "@catalyst/pki",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "private": true,
  "dependencies": {
    "@catalyst/config": "catalog:",
    "@catalyst/telemetry": "catalog:",
    "@peculiar/x509": "^1.12.3",
    "zod": "catalog:"
  },
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test $(find . \\( -name '*.test.ts' -o -name '*.spec.ts' \\) ! -path '*/node_modules/*' | grep -vE 'integration|container')",
    "test:integration": "bun test $(find . \\( -name '*.test.ts' -o -name '*.spec.ts' \\) ! -path '*/node_modules/*' | grep -E 'integration|container')"
  },
  "devDependencies": {
    "@types/bun": "catalog:dev",
    "@types/node": "catalog:dev",
    "typescript": "catalog:dev"
  }
}
```

**Why `@peculiar/x509`:** Built on W3C SubtleCrypto (Bun-compatible, no native
addons). Full X.509 v3 extension support including SPIFFE URI SANs, CSR
generation, chain validation. See ADR 0011 Section 10.1.

### 1.2 `packages/pki/tsconfig.json`

Extends root tsconfig like all other packages.

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true,
    "types": ["bun"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

Pattern: Same as `packages/authorization/tsconfig.json`.

### 1.3 Root `package.json` catalog entry

Add to `workspaces.catalog`:

```json
"@catalyst/pki": "workspace:*"
```

### 1.4 `packages/pki/src/types.ts`

Core types and interfaces. No external dependencies beyond Zod for schemas.

```typescript
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
 *
 * Per architect amendment #2 — this abstraction enables swapping the signing
 * implementation without touching the CertificateManager.
 */
export interface ISigningBackend {
  /** Generate a new ECDSA P-384 key pair. Returns the CryptoKeyPair. */
  generateKeyPair(): Promise<CryptoKeyPair>

  /**
   * Sign a certificate. The backend receives the to-be-signed certificate
   * (as an @peculiar/x509 X509Certificate) and the signing CA's private key,
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
  /** The signing CA's certificate (for AKI extension); undefined for self-signed */
  signingCert?: string
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
```

**Patterns followed:**

- Interface naming: `I` prefix for store/backend interfaces (matches `IKeyStore`, `IKeyManager`)
- Zod schemas alongside types (matches `packages/authorization/src/service/rpc/schema.ts`)
- Discriminated union style (matches existing `success/error` patterns)
- `CertificateRecord` mirrors `TokenRecord` from `packages/authorization/src/jwt/index.ts`

### 1.5 `packages/pki/src/index.ts`

Public API barrel export.

```typescript
// Types
export type {
  CertificateRecord,
  CertificateType,
  CertificateStatus,
  ServiceType as PkiServiceType,
  DenyListEntry,
  ICertificateStore,
  ISigningBackend,
  SignCertificateParams,
  KeyUsageFlags,
  ExtKeyUsage,
  ValidatedCSR,
  SignCSRRequest,
  SignCSRResult,
  CaBundleResponse,
  PkiHealthStatus,
  PkiStatusResponse,
  CaStatusInfo,
} from './types.js'

// Schemas
export {
  SignCSRRequestSchema,
  DenyIdentityRequestSchema,
  AllowIdentityRequestSchema,
} from './types.js'

// Implementations
export { BunSqliteCertificateStore } from './store/sqlite-certificate-store.js'
export { WebCryptoSigningBackend } from './signing/webcrypto-signing-backend.js'
export { CertificateManager } from './certificate-manager.js'
```

### 1.6 Tests for Step 1

**File:** `packages/pki/tests/types.test.ts`

Validates Zod schemas parse correctly and reject invalid input.

```typescript
// Tests:
// - SignCSRRequestSchema accepts valid input
// - SignCSRRequestSchema rejects missing csrPem
// - SignCSRRequestSchema rejects invalid serviceType
// - DenyIdentityRequestSchema requires spiffe:// prefix
// - AllowIdentityRequestSchema requires spiffe:// prefix
```

---

## Step 2: SQLite Certificate Store

### 2.1 `packages/pki/src/store/sqlite-certificate-store.ts`

**Contains:** `BunSqliteCertificateStore` class implementing `ICertificateStore`.

**Pattern:** Mirrors `BunSqliteKeyStore` and `BunSqliteTokenStore` from
`packages/authorization`. Constructor accepts a path string (`:memory:` for
tests). Schema created in `initialize()` called from constructor.

```typescript
import { Database } from 'bun:sqlite'
import type {
  ICertificateStore,
  CertificateRecord,
  CertificateType,
  CertificateStatus,
  DenyListEntry,
} from '../types.js'

export class BunSqliteCertificateStore implements ICertificateStore {
  private db: Database

  constructor(path: string = ':memory:') {
    this.db = new Database(path)
    this.createSchema()
  }

  private createSchema(): void {
    // Runs inside a transaction for atomicity
    this.db.run('BEGIN')
    try {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS certificate (
          serial TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,           -- 'root-ca' | 'services-ca' | 'transport-ca' | 'end-entity'
          common_name TEXT NOT NULL,
          spiffe_id TEXT,               -- null for CA certs
          certificate_pem TEXT NOT NULL,
          private_key_pem TEXT,         -- null when we don't hold the key
          issuer_serial TEXT,           -- null for self-signed root
          not_before INTEGER NOT NULL,  -- ms since epoch
          not_after INTEGER NOT NULL,   -- ms since epoch
          status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'superseded' | 'expired'
          created_at INTEGER NOT NULL
        )
      `)

      this.db.run(`CREATE INDEX IF NOT EXISTS idx_cert_type_status ON certificate(type, status)`)
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_cert_fingerprint ON certificate(fingerprint)`)
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_cert_spiffe_id ON certificate(spiffe_id)`)
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_cert_not_after ON certificate(not_after)`)

      this.db.run(`
        CREATE TABLE IF NOT EXISTS denied_identity (
          spiffe_id TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          denied_at INTEGER NOT NULL    -- ms since epoch
        )
      `)

      this.db.run('COMMIT')
    } catch (err) {
      this.db.run('ROLLBACK')
      throw err
    }
  }

  // --- ICertificateStore implementation ---

  async saveCaCertificate(record: CertificateRecord): Promise<void>
  // INSERT OR REPLACE into certificate table
  // Sets status='active' on the new cert
  // If another cert of the same type was 'active', sets it to 'superseded'

  async loadCaCertificate(
    type: 'root-ca' | 'services-ca' | 'transport-ca'
  ): Promise<CertificateRecord | null>
  // SELECT ... WHERE type = ? AND status = 'active' LIMIT 1

  async loadAllCaCertificates(
    type: 'root-ca' | 'services-ca' | 'transport-ca'
  ): Promise<CertificateRecord[]>
  // SELECT ... WHERE type = ? AND status IN ('active', 'superseded') ORDER BY created_at DESC

  async saveEndEntityCertificate(record: CertificateRecord): Promise<void>
  // INSERT into certificate table with type='end-entity'

  async findBySerial(serial: string): Promise<CertificateRecord | null>
  // SELECT ... WHERE serial = ?

  async findByFingerprint(fingerprint: string): Promise<CertificateRecord | null>
  // SELECT ... WHERE fingerprint = ?

  async findBySpiffeId(spiffeId: string): Promise<CertificateRecord[]>
  // SELECT ... WHERE spiffe_id = ? AND status = 'active' AND not_after > now

  async listActiveCertificates(): Promise<CertificateRecord[]>
  // SELECT ... WHERE type = 'end-entity' AND status = 'active' AND not_after > now

  async markSuperseded(serial: string): Promise<void>
  // UPDATE certificate SET status = 'superseded' WHERE serial = ?

  async denyIdentity(spiffeId: string, reason: string): Promise<void>
  // INSERT OR REPLACE into denied_identity

  async allowIdentity(spiffeId: string): Promise<void>
  // DELETE FROM denied_identity WHERE spiffe_id = ?

  async isDenied(spiffeId: string): Promise<boolean>
  // SELECT 1 FROM denied_identity WHERE spiffe_id = ? LIMIT 1

  async listDeniedIdentities(): Promise<DenyListEntry[]>
  // SELECT * FROM denied_identity ORDER BY denied_at DESC

  async purgeExpired(cutoffMs: number): Promise<number>
  // DELETE FROM certificate WHERE not_after < ? AND type = 'end-entity'
  // Returns this.db.changes

  async countCertificates(): Promise<
    { type: CertificateType; status: CertificateStatus; count: number }[]
  >
  // SELECT type, status, COUNT(*) as count FROM certificate GROUP BY type, status
}
```

**Key patterns from existing code:**

- Constructor takes `path: string = ':memory:'` (same as `BunSqliteKeyStore:8`)
- Uses `bun:sqlite` `Database` directly (same as all existing stores)
- Prepared statements with `$param` style bindings (same as `BunSqliteTokenStore:43-56`)
- Index on lookup columns (same as `BunSqliteTokenStore:36-39`)

### 2.2 Tests for Step 2

**File:** `packages/pki/tests/store/sqlite-certificate-store.test.ts`

All tests use `:memory:` database.

```
Tests:
- saveCaCertificate + loadCaCertificate round-trip
- loadCaCertificate returns null when no CA exists
- saveCaCertificate supersedes previous active CA of same type
- loadAllCaCertificates returns both active and superseded
- saveEndEntityCertificate + findBySerial round-trip
- findByFingerprint returns correct record
- findBySpiffeId returns only active, non-expired certs
- listActiveCertificates excludes expired and superseded
- markSuperseded changes status
- denyIdentity + isDenied round-trip
- allowIdentity removes from deny list
- listDeniedIdentities returns all entries ordered by denied_at
- purgeExpired removes old end-entity certs and returns count
- purgeExpired does NOT remove CA certificates
- countCertificates returns grouped counts
```

---

## Step 3: WebCrypto Signing Backend

### 3.1 `packages/pki/src/signing/webcrypto-signing-backend.ts`

**Contains:** `WebCryptoSigningBackend` class implementing `ISigningBackend`.

Uses `@peculiar/x509` for all certificate operations. Uses Bun's built-in
`crypto.subtle` for key generation and fingerprinting.

```typescript
import * as x509 from '@peculiar/x509'
import type { ISigningBackend, SignCertificateParams } from '../types.js'

// Set the @peculiar/x509 crypto provider to use Bun's SubtleCrypto
x509.cryptoProvider.set(crypto)

/** ECDSA P-384 algorithm parameters */
const EC_ALGORITHM: EcKeyGenParams = {
  name: 'ECDSA',
  namedCurve: 'P-384',
}

/** Signing algorithm for SHA-384 */
const SIGNING_ALGORITHM: EcdsaParams = {
  name: 'ECDSA',
  hash: 'SHA-384',
}

export class WebCryptoSigningBackend implements ISigningBackend {
  async generateKeyPair(): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey(EC_ALGORITHM, true, ['sign', 'verify'])
  }

  async signCertificate(params: SignCertificateParams): Promise<string> {
    // 1. Build X.509 extensions array
    const extensions: x509.Extension[] = []

    // Basic Constraints
    extensions.push(
      new x509.BasicConstraintsExtension(
        params.isCa,
        params.pathLenConstraint,
        true // critical
      )
    )

    // Key Usage
    let keyUsageFlags = 0
    if (params.keyUsage.digitalSignature) keyUsageFlags |= x509.KeyUsageFlags.digitalSignature
    if (params.keyUsage.keyCertSign) keyUsageFlags |= x509.KeyUsageFlags.keyCertSign
    if (params.keyUsage.crlSign) keyUsageFlags |= x509.KeyUsageFlags.cRLSign
    extensions.push(new x509.KeyUsageExtension(keyUsageFlags, true))

    // Extended Key Usage (end-entity only)
    if (params.extKeyUsage && params.extKeyUsage.length > 0) {
      const oids: string[] = []
      for (const eku of params.extKeyUsage) {
        if (eku === 'serverAuth') oids.push(x509.ExtendedKeyUsage.serverAuth)
        if (eku === 'clientAuth') oids.push(x509.ExtendedKeyUsage.clientAuth)
      }
      extensions.push(new x509.ExtendedKeyUsageExtension(oids, false))
    }

    // Subject Alternative Names
    if (params.sanUri || params.sanDns?.length) {
      const entries: x509.JsonGeneralName[] = []
      if (params.sanUri) entries.push({ type: 'url', value: params.sanUri })
      if (params.sanDns) {
        for (const dns of params.sanDns) {
          entries.push({ type: 'dns', value: dns })
        }
      }
      extensions.push(new x509.SubjectAlternativeNameExtension(entries, false))
    }

    // Subject Key Identifier (all certs — required by ADR 0011 Section 3.1)
    extensions.push(await x509.SubjectKeyIdentifierExtension.create(params.subjectPublicKey))

    // Authority Key Identifier (non-self-signed certs — required by ADR 0011 Sections 3.2/3.3)
    // Without AKI, CA rotation breaks: two intermediates with the same subject CN
    // cannot be distinguished by verifiers during the grace period.
    if (params.signingCert) {
      const issuerCert = new x509.X509Certificate(params.signingCert)
      extensions.push(await x509.AuthorityKeyIdentifierExtension.create(issuerCert))
    }

    // Name Constraints (intermediate CAs only — security boundary between Services/Transport CAs)
    // Without name constraints, a compromised Services CA could issue envoy certs.
    if (params.nameConstraints && params.nameConstraints.permittedUris.length > 0) {
      const permitted = params.nameConstraints.permittedUris.map((uri) => ({
        type: 'uniformResourceIdentifier' as const,
        value: uri,
      }))
      extensions.push(
        new x509.NameConstraintsExtension(
          { permitted },
          true // critical
        )
      )
    }

    // 2. Generate serial number
    const serialNumber = params.serialNumber ?? crypto.randomUUID().replace(/-/g, '')

    // 3. Create the certificate
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber,
      subject: `CN=${params.subjectCN}`,
      issuer: params.signingCert
        ? new x509.X509Certificate(params.signingCert).subject
        : `CN=${params.subjectCN}`, // self-signed
      notBefore: params.notBefore,
      notAfter: params.notAfter,
      signingAlgorithm: SIGNING_ALGORITHM,
      publicKey: params.subjectPublicKey,
      signingKey: params.signingKey,
      extensions,
    })

    return cert.toString('pem')
  }

  async exportPrivateKeyPem(key: CryptoKey): Promise<string> {
    const exported = await crypto.subtle.exportKey('pkcs8', key)
    return x509.PemConverter.encode(exported, 'PRIVATE KEY')
  }

  async importPrivateKeyPem(pem: string): Promise<CryptoKey> {
    const der = x509.PemConverter.decode(pem)[0]
    return crypto.subtle.importKey('pkcs8', der, EC_ALGORITHM, true, ['sign'])
  }

  async exportPublicKeyPem(key: CryptoKey): Promise<string> {
    const exported = await crypto.subtle.exportKey('spki', key)
    return x509.PemConverter.encode(exported, 'PUBLIC KEY')
  }

  async computeFingerprint(certDer: ArrayBuffer): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', certDer)
    // Base64url encode, no padding (RFC 4648 Section 5)
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }
}
```

**Why a separate class instead of inline crypto:**

- Per architect amendment #2, `ISigningBackend` must be swappable for cloud KMS
- Phase 2 will add `AwsKmsSigningBackend` and `GcpKmsSigningBackend` behind the
  same interface
- Testing can use the WebCrypto backend directly; no mocking needed

### 3.2 Tests for Step 3

**File:** `packages/pki/tests/signing/webcrypto-signing-backend.test.ts`

```
Tests:
- generateKeyPair returns P-384 key pair with sign/verify usages
- signCertificate creates valid self-signed root CA cert
  - Verify: subject CN, basicConstraints CA:TRUE, keyUsage keyCertSign+crlSign, pathlen:1
  - Verify: SKI extension present (SubjectKeyIdentifier)
  - Verify: AKI extension absent (self-signed)
- signCertificate creates valid intermediate CA cert signed by root
  - Verify: chain validates, pathlen:0, name constraints present
  - Verify: SKI extension present, AKI extension matches root's SKI
- signCertificate creates valid end-entity cert with SPIFFE URI SAN
  - Verify: URI SAN is spiffe://..., DNS SANs present, CA:FALSE, serverAuth+clientAuth EKU
  - Verify: SKI extension present, AKI extension matches issuing CA's SKI
- exportPrivateKeyPem + importPrivateKeyPem round-trip
  - Import the key back and sign data — verify with original public key
- exportPublicKeyPem outputs valid SPKI PEM
- computeFingerprint returns base64url SHA-256 with no padding
  - Cross-check against known test vector
```

---

## Step 4: Certificate Manager

### 4.1 `packages/pki/src/certificate-manager.ts`

**Contains:** `CertificateManager` class — the main facade for all PKI
operations. Mirrors `JWTTokenFactory` (facade composing store + backend).

```typescript
import type {
  ICertificateStore,
  ISigningBackend,
  CertificateRecord,
  SignCSRRequest,
  SignCSRResult,
  CaBundleResponse,
  PkiStatusResponse,
  DenyListEntry,
} from './types.js'
import { BunSqliteCertificateStore } from './store/sqlite-certificate-store.js'
import { WebCryptoSigningBackend } from './signing/webcrypto-signing-backend.js'

/** Configuration for CertificateManager */
export interface CertificateManagerConfig {
  /** Path to SQLite database for certificate storage */
  certsDbFile?: string
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
   * Pattern: Mirrors JWTTokenFactory.ephemeral() from
   * packages/authorization/src/jwt/jwt-token-factory.ts:92-101
   */
  static ephemeral(config?: { trustDomain?: string; svidTtlSeconds?: number }): CertificateManager {
    return new CertificateManager(
      new BunSqliteCertificateStore(':memory:'),
      new WebCryptoSigningBackend(),
      {
        certsDbFile: ':memory:',
        trustDomain: config?.trustDomain,
        svidTtlSeconds: config?.svidTtlSeconds,
      }
    )
  }

  /** Whether the CA hierarchy has been initialized */
  isInitialized(): boolean {
    return this.initialized
  }

  // ===== CA Lifecycle =====

  /**
   * Initialize the full CA hierarchy (root + services CA + transport CA).
   * If a root CA already exists, loads it and skips generation.
   *
   * Flow 1 from interaction-flows.md
   */
  async initialize(): Promise<{
    rootFingerprint: string
    servicesCaFingerprint: string
    transportCaFingerprint: string
  }> {
    // 1. Check for existing root CA
    const existingRoot = await this.store.loadCaCertificate('root-ca')
    if (existingRoot) {
      // Load existing — resume from stored state
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

    // 2. Generate Root CA
    const rootKeyPair = await this.backend.generateKeyPair()
    const rootCertPem = await this.backend.signCertificate({
      subjectCN: 'Catalyst Root CA',
      signingKey: rootKeyPair.privateKey,
      signingCert: undefined, // self-signed: no issuer cert
      subjectPublicKey: rootKeyPair.publicKey,
      notBefore: new Date(),
      notAfter: new Date(Date.now() + 10 * 365.25 * 24 * 60 * 60 * 1000), // 10 years
      isCa: true,
      pathLenConstraint: 1,
      keyUsage: { keyCertSign: true, crlSign: true },
    })
    // ... store root, generate services CA, generate transport CA
    // (full implementation follows the 12-step sequence in Flow 1)

    this.initialized = true
    return { rootFingerprint, servicesCaFingerprint, transportCaFingerprint }
  }

  // ===== CSR Signing =====

  /**
   * Validate and sign a CSR, producing an end-entity SVID.
   *
   * Flow 2 from interaction-flows.md (steps 5-7)
   *
   * @throws Error if identity is denied, CSR is invalid, or CA is not initialized
   */
  async signCSR(request: SignCSRRequest): Promise<SignCSRResult> {
    if (!this.initialized) throw new Error('CA not initialized')

    // 1. Build expected SPIFFE ID
    const expectedSpiffeId = `spiffe://${this.trustDomain}/${request.serviceType}/${request.instanceId}`

    // 2. Check deny list
    const denied = await this.store.isDenied(expectedSpiffeId)
    if (denied) throw new Error(`Identity denied: ${expectedSpiffeId}`)

    // 3. Parse and validate CSR (proof-of-possession + identity validation)
    //    Without CSR signature verification, an attacker can submit CSRs with
    //    someone else's public key and obtain certificates for arbitrary identities.
    const csr = new x509.Pkcs10CertificateRequest(request.csrPem)

    // 3a. Verify CSR self-signature (proof-of-possession of the private key)
    const csrValid = await csr.verify()
    if (!csrValid) throw new Error('CSR signature verification failed')

    // 3b. Extract and validate the SPIFFE URI SAN from the CSR
    const csrSanExt = csr.getExtension('2.5.29.17') // subjectAltName
    // Parse the SAN extension, find the URI entry, compare to expectedSpiffeId
    // Reject if SPIFFE URI does not match or is missing

    // 3c. Validate key algorithm is P-384 (Phase 1 requirement)
    const csrKeyAlg = csr.publicKey.algorithm as EcKeyAlgorithm
    if (csrKeyAlg.namedCurve !== 'P-384') {
      throw new Error(`Key algorithm must be P-384, got ${csrKeyAlg.namedCurve}`)
    }

    // 3d. Extract the subject public key for certificate signing
    const validatedCsr = {
      subjectPublicKey: await csr.publicKey.export(),
      spiffeId: expectedSpiffeId,
    }

    // 4. Determine which CA signs this cert
    const isTransport = request.serviceType.startsWith('envoy/')
    const caType = isTransport ? 'transport-ca' : 'services-ca'
    const ca = await this.store.loadCaCertificate(caType)
    if (!ca || !ca.privateKeyPem) throw new Error(`Signing CA not available: ${caType}`)

    // 5. Compute TTL (requested, capped at max)
    const ttl = Math.min(request.ttlSeconds ?? this.svidTtlSeconds, this.maxSvidTtlSeconds)
    const notBefore = new Date()
    const notAfter = new Date(Date.now() + ttl * 1000)

    // 6. Determine EKU based on service type
    const extKeyUsage = this.getExtKeyUsage(request.serviceType)

    // 7. Sign the certificate
    const caPrivateKey = await this.backend.importPrivateKeyPem(ca.privateKeyPem)
    const certPem = await this.backend.signCertificate({
      subjectCN: request.instanceId,
      sanUri: expectedSpiffeId,
      sanDns: [request.instanceId],
      signingKey: caPrivateKey,
      signingCert: ca.certificatePem,
      subjectPublicKey: validatedCsr.subjectPublicKey,
      notBefore,
      notAfter,
      isCa: false,
      keyUsage: { digitalSignature: true },
      extKeyUsage,
    })

    // 8. Compute fingerprint and store
    // ... save to store, build chain, return result

    return {
      certificatePem: certPem,
      chain: [ca.certificatePem, rootCa.certificatePem],
      expiresAt: notAfter.toISOString(),
      renewAfter: new Date(notBefore.getTime() + ttl * 500).toISOString(), // 50% of lifetime, relative to notBefore
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

  /** Get the trust bundle for distribution. Flow 10. */
  async getCaBundle(): Promise<CaBundleResponse> {
    const root = await this.store.loadCaCertificate('root-ca')
    const servicesCas = await this.store.loadAllCaCertificates('services-ca')
    const transportCas = await this.store.loadAllCaCertificates('transport-ca')
    if (!root) throw new Error('CA not initialized')

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

  /** Deny a SPIFFE identity. Flow 9. */
  async denyIdentity(
    spiffeId: string,
    reason: string
  ): Promise<{
    expiringCerts: { serial: string; expiresAt: string }[]
  }> {
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
    // ... build full status response with warnings
  }

  // ===== Maintenance =====

  /** Purge expired certificates. Returns count of purged records. */
  async purgeExpired(): Promise<number> {
    // Purge certs that expired more than 24 hours ago
    // (keep recently expired for audit trail)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return this.store.purgeExpired(cutoff)
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
```

**Key design decisions:**

- Constructor takes `(store, backend, config?)` — dependency injection like
  `PersistentLocalKeyManager(store, options)`
- `ephemeral()` static factory mirrors `JWTTokenFactory.ephemeral()` exactly
- `initialize()` is idempotent (check-then-create, same as `PersistentLocalKeyManager.initialize()`)
- Methods throw errors on invalid state (same as `PersistentLocalKeyManager` throwing `'Not initialized'`)
- `getStore()` / `getBackend()` accessors mirror `JWTTokenFactory.getKeyManager()`

### 4.2 Tests for Step 4

**File:** `packages/pki/tests/certificate-manager.test.ts`

All tests use `CertificateManager.ephemeral()`.

```
Tests:
- initialize() creates root CA + 2 intermediates
- initialize() is idempotent (second call loads existing)
- initialize() returns fingerprints for all 3 CAs
- signCSR() produces valid end-entity cert for orchestrator
  - Verify: SPIFFE URI SAN, DNS SAN, CA:FALSE, serverAuth+clientAuth
  - Verify: chain validates (leaf -> services CA -> root)
  - Verify: default TTL is 1 hour
- signCSR() produces valid end-entity cert for gateway (serverAuth only)
- signCSR() produces valid envoy cert signed by transport CA (not services CA)
- signCSR() rejects request when identity is denied
- signCSR() caps TTL at maxSvidTtlSeconds
- signCSR() throws if CA not initialized
- getCaBundle() returns both service and transport bundles
- getCaBundle() includes both active + retiring CAs after rotation
- denyIdentity() adds to deny list and returns expiring certs
- allowIdentity() removes from deny list
- purgeExpired() removes old certs, keeps recent
- getStatus() returns 'uninitialized' before initialize()
- getStatus() returns 'healthy' after initialize()
- getStatus() returns warnings for CA approaching expiry
- ephemeral() creates working in-memory instance
```

---

## Step 5: Progressive RPC API

### 5.1 `packages/pki/src/rpc/schema.ts`

**Contains:** Zod schemas and handler interface for the `pki()` progressive
API entry point on `AuthRpcServer`.

```typescript
import { z } from 'zod'
import type { SignCSRResult, CaBundleResponse, PkiStatusResponse, DenyListEntry } from '../types.js'
import {
  SignCSRRequestSchema,
  DenyIdentityRequestSchema,
  AllowIdentityRequestSchema,
} from '../types.js'

// Re-export request schemas
export { SignCSRRequestSchema, DenyIdentityRequestSchema, AllowIdentityRequestSchema }

// ----- Response schemas -----

export const InitializeResultSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    rootFingerprint: z.string(),
    servicesCaFingerprint: z.string(),
    transportCaFingerprint: z.string(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
])

export type InitializeResult = z.infer<typeof InitializeResultSchema>

export const SignCSRResultSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    certificatePem: z.string(),
    chain: z.array(z.string()),
    expiresAt: z.string(),
    renewAfter: z.string(),
    fingerprint: z.string(),
    serial: z.string(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
])

export const DenyIdentityResultSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    expiringCerts: z.array(
      z.object({
        serial: z.string(),
        expiresAt: z.string(),
      })
    ),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
])

// ----- Progressive API handler interface -----

/**
 * PKI sub-API handlers returned by AuthRpcServer.pki(token).
 *
 * Pattern: Matches TokenHandlers, CertHandlers, ValidationHandlers
 * from packages/authorization/src/service/rpc/schema.ts:150-186
 */
export interface PkiHandlers {
  /** Initialize the CA hierarchy (first-time setup) */
  initialize(): Promise<InitializeResult>

  /** Sign a CSR and return a certificate */
  signCsr(
    request: z.infer<typeof SignCSRRequestSchema>
  ): Promise<z.infer<typeof SignCSRResultSchema>>

  /** Get the CA trust bundle */
  getCaBundle(): Promise<CaBundleResponse>

  /** Get PKI system status */
  getStatus(): Promise<PkiStatusResponse>

  /** Deny a SPIFFE identity (passive revocation) */
  denyIdentity(
    request: z.infer<typeof DenyIdentityRequestSchema>
  ): Promise<z.infer<typeof DenyIdentityResultSchema>>

  /** Re-enable a denied identity */
  allowIdentity(request: z.infer<typeof AllowIdentityRequestSchema>): Promise<{ success: boolean }>

  /** List all denied identities */
  listDeniedIdentities(): Promise<DenyListEntry[]>

  /** List all active certificates */
  listCertificates(): Promise<
    { serial: string; spiffeId: string; fingerprint: string; expiresAt: string; status: string }[]
  >

  /** Purge expired certificates */
  purgeExpired(): Promise<{ purgedCount: number }>
}
```

**Pattern:** Exactly mirrors the `TokenHandlers`, `CertHandlers`, `ValidationHandlers`,
`PermissionsHandlers` interfaces in `packages/authorization/src/service/rpc/schema.ts`.
Each method returns a Promise of a typed result. The outer `pki(token)` call
handles auth; the inner methods are pre-authorized.

### 5.2 Changes to `packages/authorization/src/service/rpc/server.ts`

**Modification:** Add `pki()` method to `AuthRpcServer`.

Add import:

```typescript
import type { CertificateManager } from '@catalyst/pki'
import type { PkiHandlers } from '@catalyst/pki/src/rpc/schema.js'
```

Add to constructor:

```typescript
constructor(
  private tokenFactory: JWTTokenFactory,
  private telemetry: ServiceTelemetry,
  private policyService?: CatalystPolicyEngine,
  private nodeId: string = 'unknown',
  private domainId: string = '',
  private certificateManager?: CertificateManager  // NEW
) {
  super()
}
```

Add new progressive API method (after the existing `permissions()` method):

```typescript
/**
 * PKI certificate management sub-api.
 * Requires ADMIN principal for write operations.
 * Read operations (getCaBundle, getStatus) require any valid token.
 */
async pki(token: string): Promise<PkiHandlers | { error: string }> {
  const logger = this.telemetry.logger
  const auth = await this.tokenFactory.verify(token)
  if (!auth.valid) {
    return { error: 'Invalid token' }
  }

  if (!this.certificateManager) {
    return { error: 'PKI not configured' }
  }

  // Cedar policy check for ADMIN (same pattern as tokens() method)
  const principal = jwtToEntity(auth.payload as Record<string, unknown>)
  const builder = this.policyService?.entityBuilderFactory.createEntityBuilder()
  if (!builder) {
    return { error: 'Policy service not configured' }
  }
  builder.entity(principal.uid.type, principal.uid.id).setAttributes(principal.attrs)
  builder
    .entity('CATALYST::AdminPanel', 'admin-panel')
    .setAttributes({ nodeId: this.nodeId, domainId: this.domainId })
  const entities = builder.build()
  const authorizedResult = this.policyService?.isAuthorized({
    principal: principal.uid,
    action: 'CATALYST::Action::MANAGE',
    resource: { type: 'CATALYST::AdminPanel', id: 'admin-panel' },
    entities: entities.getAll(),
    context: {},
  })

  if (authorizedResult?.type === 'failure') {
    void logger.error`Policy service error: ${authorizedResult.errors}`
    return { error: 'Error authorizing request' }
  }

  if (authorizedResult?.type === 'evaluated' && !authorizedResult.allowed) {
    void logger.warn`Permission denied for PKI: decision=${authorizedResult.decision}, reasons=${authorizedResult.reasons}`
    return { error: 'Permission denied: ADMIN principal required' }
  }

  const cm = this.certificateManager

  return {
    initialize: async () => {
      try {
        const result = await cm.initialize()
        return { success: true, ...result }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    signCsr: async (request) => {
      try {
        const result = await cm.signCSR(request)
        return { success: true, ...result }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    getCaBundle: () => cm.getCaBundle(),
    getStatus: () => cm.getStatus(),
    denyIdentity: async (request) => {
      try {
        const result = await cm.denyIdentity(request.spiffeId, request.reason)
        return { success: true, ...result }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    allowIdentity: async (request) => {
      try {
        await cm.allowIdentity(request.spiffeId)
        return { success: true }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    listDeniedIdentities: () => cm.listDeniedIdentities(),
    listCertificates: async () => {
      const certs = await cm.getStore().listActiveCertificates()
      return certs.map(c => ({
        serial: c.serial,
        spiffeId: c.spiffeId ?? '',
        fingerprint: c.fingerprint,
        expiresAt: new Date(c.notAfter).toISOString(),
        status: c.status,
      }))
    },
    purgeExpired: async () => {
      const count = await cm.purgeExpired()
      return { purgedCount: count }
    },
  }
}
```

**Pattern match:**

- Token validation first, then Cedar policy check, then return handler object
  (exactly matches `tokens()` at lines 65-127 of server.ts)
- Each handler method wraps errors in `{ success: false, error }` (matches
  existing error handling pattern)
- Handler methods are closures over `cm` (the certificate manager), same as
  how `tokens()` closures capture `this.tokenFactory`

### 5.3 Changes to `packages/authorization/src/service/rpc/schema.ts`

Add the `PkiHandlers` type import and re-export:

```typescript
export type { PkiHandlers } from '@catalyst/pki/src/rpc/schema.js'
```

This keeps all handler types accessible from the existing schema module.

### 5.4 `packages/authorization/package.json`

Add `@catalyst/pki` dependency:

```json
"dependencies": {
  "@catalyst/pki": "catalog:",
  // ... existing deps
}
```

### 5.5 Tests for Step 5

**File:** `packages/pki/tests/rpc/pki-handlers.test.ts`

Tests the `pki()` progressive API through a mock `AuthRpcServer` setup.

```
Tests:
- pki(invalidToken) returns { error: 'Invalid token' }
- pki(validNonAdminToken) returns { error: 'Permission denied: ADMIN principal required' }
- pki(adminToken).initialize() creates CA hierarchy
- pki(adminToken).signCsr() returns signed certificate
- pki(adminToken).signCsr() rejects denied identity
- pki(adminToken).getCaBundle() returns trust bundles
- pki(adminToken).getStatus() returns health info
- pki(adminToken).denyIdentity() adds to deny list
- pki(adminToken).allowIdentity() removes from deny list
- pki(adminToken).listDeniedIdentities() returns list
- pki(adminToken).listCertificates() returns active certs
- pki(adminToken).purgeExpired() removes old certs
```

---

## Step 6: HTTP Endpoints

### 6.1 Changes to `packages/authorization/src/service/service.ts`

Add public HTTP endpoints to the auth service handler for CA bundle access
and CSR signing. These run alongside the RPC endpoint.

**Modifications to `AuthService.onInitialize()`:**

```typescript
// After RPC server setup (line 95)...

// Mount PKI HTTP endpoints
if (this._certificateManager) {
  // Public: CA bundle (no auth required — read-only trust anchor distribution)
  this.handler.get('/pki/ca/bundle', async (c) => {
    try {
      const bundle = await this._certificateManager!.getCaBundle()
      const etag = `"${bundle.version}"`
      if (c.req.header('If-None-Match') === etag) {
        return c.body(null, 304)
      }
      c.header('ETag', etag)
      c.header('Cache-Control', 'public, max-age=300')
      return c.json(bundle)
    } catch (err) {
      return c.json({ error: 'CA not initialized' }, 503)
    }
  })

  // Authenticated: CSR signing (bootstrap token or valid service cert)
  this.handler.post('/pki/csr/sign', async (c) => {
    // 1. Extract and verify authorization token
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authorization' }, 401)
    }
    const token = authHeader.slice(7)
    const auth = await this._tokenFactory.verify(token)
    if (!auth.valid) {
      return c.json({ error: 'Invalid token' }, 401)
    }

    // 2. Parse and validate request body
    const body = await c.req.json()
    const parsed = SignCSRRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400)
    }

    // 3. Sign CSR
    try {
      const result = await this._certificateManager!.signCSR(parsed.data)
      return c.json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith('Identity denied')) {
        return c.json({ error: message }, 403)
      }
      return c.json({ error: message }, 500)
    }
  })
}
```

**Pattern:** Matches the existing `/.well-known/jwks.json` endpoint pattern
at lines 90-94 of service.ts. Public GET endpoints with Cache-Control headers;
authenticated POST endpoints that verify the token first.

### 6.2 Tests for Step 6

**File:** `packages/authorization/tests/service/pki-http.test.ts`

Tests HTTP endpoints using Hono's `app.request()` test helper.

```
Tests:
- GET /pki/ca/bundle returns JSON with servicesBundle and transportBundle
- GET /pki/ca/bundle returns 304 when ETag matches If-None-Match
- GET /pki/ca/bundle returns 503 when PKI not initialized
- POST /pki/csr/sign returns signed certificate with valid token
- POST /pki/csr/sign returns 401 without authorization header
- POST /pki/csr/sign returns 401 with invalid token
- POST /pki/csr/sign returns 400 with malformed request body
- POST /pki/csr/sign returns 403 when identity is denied
```

---

## Step 7: Auth Service Wiring

### 7.1 Changes to `packages/authorization/src/service/service.ts`

**Full modified file structure:**

```typescript
import { JWTTokenFactory } from '../jwt/jwt-token-factory.js'
import { CertificateManager } from '@catalyst/pki' // NEW
import { BunSqliteCertificateStore } from '@catalyst/pki' // NEW
import { WebCryptoSigningBackend } from '@catalyst/pki' // NEW
import { SignCSRRequestSchema } from '@catalyst/pki' // NEW
import {
  ALL_POLICIES,
  AuthorizationEngine,
  CATALYST_SCHEMA,
  type CatalystPolicyDomain,
  Principal,
} from '../policy/src/index.js'
import { CatalystService, type CatalystServiceOptions } from '@catalyst/service'
import { Hono } from 'hono'
import { AuthRpcServer, createAuthRpcHandler } from './rpc/server.js'

export class AuthService extends CatalystService {
  readonly info = { name: 'auth', version: '0.0.0' }
  readonly handler = new Hono()

  private _tokenFactory!: JWTTokenFactory
  private _rpcServer!: AuthRpcServer
  private _systemToken!: string
  private _certificateManager?: CertificateManager // NEW

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  get tokenFactory(): JWTTokenFactory {
    return this._tokenFactory
  }
  get rpcServer(): AuthRpcServer {
    return this._rpcServer
  }
  get systemToken(): string {
    return this._systemToken
  }
  get certificateManager(): CertificateManager | undefined {
    // NEW
    return this._certificateManager
  }

  protected async onInitialize(): Promise<void> {
    const logger = this.telemetry.logger

    // 1. Initialize JWT token factory (existing, unchanged)
    this._tokenFactory = new JWTTokenFactory({
      local: {
        keyDbFile: this.config.auth?.keysDb,
        tokenDbFile: this.config.auth?.tokensDb,
        nodeId: this.config.node.name,
      },
    })
    await this._tokenFactory.initialize()
    void logger.info`JWTTokenFactory initialized`

    // 2. Initialize PKI Certificate Manager                           // NEW
    const certsDbFile = this.config.auth?.pki?.certsDb ?? 'certs.db'
    const store = new BunSqliteCertificateStore(certsDbFile)
    const backend = new WebCryptoSigningBackend()
    this._certificateManager = new CertificateManager(store, backend, {
      certsDbFile,
      trustDomain: this.config.auth?.pki?.trustDomain,
      svidTtlSeconds: this.config.auth?.pki?.svidTtlSeconds,
    })

    // Auto-initialize CA hierarchy on first boot
    const pkiResult = await this._certificateManager.initialize()
    void logger.info`PKI initialized — root: ${pkiResult.rootFingerprint}, services: ${pkiResult.servicesCaFingerprint}, transport: ${pkiResult.transportCaFingerprint}`

    // 3. Initialize policy engine (existing, unchanged)
    const policyService = new AuthorizationEngine<CatalystPolicyDomain>(
      CATALYST_SCHEMA,
      ALL_POLICIES
    )
    const validationResult = policyService.validatePolicies()
    if (!validationResult) {
      void logger.error`Invalid policies - policy validation failed`
      process.exit(1)
    }

    // 4. Mint system admin token (existing, unchanged)
    this._systemToken = await this._tokenFactory.mint({
      subject: 'bootstrap',
      entity: {
        id: 'system',
        name: 'System Admin',
        type: 'service',
        trustedDomains: this.config.node.domains,
        trustedNodes: [],
      },
      principal: Principal.ADMIN,
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    })
    void logger.info`System Admin Token minted: ${this._systemToken}`

    // 5. Build RPC server with CertificateManager                    // MODIFIED
    this._rpcServer = new AuthRpcServer(
      this._tokenFactory,
      this.telemetry,
      policyService,
      this.config.node.name,
      this.config.node.domains[0] || '',
      this._certificateManager // NEW param
    )
    this._rpcServer.setSystemToken(this._systemToken)

    // 6. Mount routes (existing + new)
    this.handler.get('/.well-known/jwks.json', async (c) => {
      const jwks = await this._tokenFactory.getJwks()
      c.header('Cache-Control', 'public, max-age=300')
      return c.json(jwks)
    })
    this.handler.route('/rpc', createAuthRpcHandler(this._rpcServer))

    // 7. Mount PKI HTTP endpoints                                    // NEW
    // GET /pki/ca/bundle (public, cached)
    // POST /pki/csr/sign (authenticated)
    // (implementation as shown in Step 6.1)
  }

  protected async onShutdown(): Promise<void> {
    await this._tokenFactory.shutdown()
    // CertificateManager has no stateful shutdown needed —
    // SQLite connections are cleaned up by GC
  }
}
```

### 7.2 Changes to `packages/config/src/index.ts`

Add PKI config to `AuthConfigSchema`:

```typescript
export const PkiConfigSchema = z
  .object({
    certsDb: z.string().default('certs.db'),
    trustDomain: z.string().default('catalyst.example.com'),
    svidTtlSeconds: z.number().int().min(60).max(86400).default(3600),
    autoRenew: z.boolean().default(true),
  })
  .optional()

export const AuthConfigSchema = z.object({
  keysDb: z.string().default('keys.db'),
  tokensDb: z.string().default('tokens.db'),
  revocation: z
    .object({
      enabled: z.boolean().default(false),
      maxSize: z.number().optional(),
    })
    .default({ enabled: false }),
  bootstrap: z
    .object({
      token: z.string().optional(),
      ttl: z
        .number()
        .default(24 * 60 * 60 * 1000)
        .optional(),
    })
    .default({}),
  pki: PkiConfigSchema, // NEW
})
```

Add env var loading in `loadDefaultConfig()`:

```typescript
auth: {
  // ... existing fields ...
  pki: {
    certsDb: process.env.CATALYST_PKI_CERTS_DB,
    trustDomain: process.env.CATALYST_PKI_TRUST_DOMAIN,
    svidTtlSeconds: process.env.CATALYST_PKI_SVID_TTL
      ? Number(process.env.CATALYST_PKI_SVID_TTL)
      : undefined,
    autoRenew: process.env.CATALYST_PKI_AUTO_RENEW !== 'false',
  },
},
```

**Environment variables:**

- `CATALYST_PKI_CERTS_DB` — path to SQLite cert store (default: `certs.db`)
- `CATALYST_PKI_TRUST_DOMAIN` — SPIFFE trust domain (default: `catalyst.example.com`)
- `CATALYST_PKI_SVID_TTL` — SVID lifetime in seconds (default: `3600`)
- `CATALYST_PKI_AUTO_RENEW` — enable auto-renewal (default: `true`)

### 7.3 Tests for Step 7

**File:** `packages/authorization/tests/service/auth-service-pki.test.ts`

Integration test for the full AuthService with PKI enabled.

```
Tests:
- AuthService.create() initializes PKI alongside JWT token factory
- AuthService.certificateManager is available after initialization
- System token can access pki() progressive API
- PKI status endpoint returns 'healthy' after initialization
- CSR signing works through the full auth service stack
- CA bundle endpoint returns trust bundles
- Deny identity flow works end-to-end through auth service
```

---

## Step 8: Integration Test (Full Flow)

### 8.1 `packages/pki/tests/integration/full-flow.integration.test.ts`

End-to-end integration test exercising the complete PKI lifecycle. Uses
ephemeral in-memory instances. No Docker or network needed.

```typescript
import { describe, test, expect } from 'bun:test'
import { CertificateManager } from '../../src/certificate-manager.js'
import * as x509 from '@peculiar/x509'

describe('PKI full lifecycle integration test', () => {
  test('complete flow: init -> sign CSR -> verify chain -> deny -> renew rejected', async () => {
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

    // 5. Verify the certificate chain
    const cert = new x509.X509Certificate(signResult.certificatePem)
    const servicesCaCert = new x509.X509Certificate(signResult.chain[0])
    const rootCaCert = new x509.X509Certificate(signResult.chain[1])

    // Verify leaf signed by services CA
    expect(cert.issuer).toBe(servicesCaCert.subject)
    // Verify services CA signed by root CA
    expect(servicesCaCert.issuer).toBe(rootCaCert.subject)

    // 6. Verify SPIFFE URI SAN
    const sanExt = cert.getExtension('2.5.29.17') // subjectAltName OID
    expect(sanExt).toBeTruthy()
    // Parse and verify the URI SAN contains the expected SPIFFE ID

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
    const csr2 = await x509.Pkcs10CertificateRequestGenerator.create({
      name: 'CN=node-a.test.local',
      keys: await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, [
        'sign',
        'verify',
      ]),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
      extensions: [
        new x509.SubjectAlternativeNameExtension([
          { type: 'url', value: 'spiffe://test.example.com/orchestrator/node-a.test.local' },
        ]),
      ],
    })

    expect(
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
  })

  test('envoy certificates are signed by transport CA, not services CA', async () => {
    const cm = CertificateManager.ephemeral({ trustDomain: 'test.example.com' })
    await cm.initialize()

    // Generate CSR for envoy/app
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
})
```

---

## Dependency Graph

```
packages/pki                          (NEW — no upstream dependencies on authorization)
  ├── @catalyst/config                (for PkiConfigSchema types)
  ├── @catalyst/telemetry             (for logging)
  ├── @peculiar/x509                  (for X.509 operations)
  └── zod                             (for schemas)

packages/authorization                (MODIFIED — gains @catalyst/pki dependency)
  ├── @catalyst/pki                   (NEW — for CertificateManager)
  ├── @catalyst/service               (existing)
  ├── @catalyst/telemetry             (existing)
  ├── ... (existing deps)

packages/config                       (MODIFIED — PkiConfigSchema added)
  └── zod                             (existing)
```

---

## File Summary

### New Files

| #   | File                                                           | Contents                                   |
| --- | -------------------------------------------------------------- | ------------------------------------------ |
| 1   | `packages/pki/package.json`                                    | Package manifest                           |
| 2   | `packages/pki/tsconfig.json`                                   | TypeScript config                          |
| 3   | `packages/pki/src/index.ts`                                    | Barrel export                              |
| 4   | `packages/pki/src/types.ts`                                    | All interfaces, types, Zod schemas         |
| 5   | `packages/pki/src/store/sqlite-certificate-store.ts`           | `BunSqliteCertificateStore`                |
| 6   | `packages/pki/src/signing/webcrypto-signing-backend.ts`        | `WebCryptoSigningBackend`                  |
| 7   | `packages/pki/src/certificate-manager.ts`                      | `CertificateManager` facade                |
| 8   | `packages/pki/src/rpc/schema.ts`                               | `PkiHandlers` interface + response schemas |
| 9   | `packages/pki/tests/types.test.ts`                             | Schema validation tests                    |
| 10  | `packages/pki/tests/store/sqlite-certificate-store.test.ts`    | Store tests                                |
| 11  | `packages/pki/tests/signing/webcrypto-signing-backend.test.ts` | Signing backend tests                      |
| 12  | `packages/pki/tests/certificate-manager.test.ts`               | Manager unit tests                         |
| 13  | `packages/pki/tests/rpc/pki-handlers.test.ts`                  | RPC handler tests                          |
| 14  | `packages/pki/tests/integration/full-flow.integration.test.ts` | End-to-end test                            |

### Modified Files

| #   | File                                                            | Changes                                                             |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| 15  | `package.json` (root)                                           | Add `@catalyst/pki` catalog entry                                   |
| 16  | `packages/config/src/index.ts`                                  | Add `PkiConfigSchema`, env var loading                              |
| 17  | `packages/authorization/package.json`                           | Add `@catalyst/pki` dependency                                      |
| 18  | `packages/authorization/src/service/rpc/server.ts`              | Add `pki()` method, `certificateManager` constructor param          |
| 19  | `packages/authorization/src/service/rpc/schema.ts`              | Re-export `PkiHandlers` type                                        |
| 20  | `packages/authorization/src/service/service.ts`                 | Wire `CertificateManager` in `onInitialize()`, mount HTTP endpoints |
| 21  | `packages/authorization/tests/service/pki-http.test.ts`         | HTTP endpoint tests                                                 |
| 22  | `packages/authorization/tests/service/auth-service-pki.test.ts` | Service integration tests                                           |

---

## Implementation Order Verification

Each step is independently testable:

| Step | What                | Can test without               | Depends on     |
| ---- | ------------------- | ------------------------------ | -------------- |
| 1    | Package + types     | Everything                     | Nothing        |
| 2    | SQLite store        | Auth service, signing, manager | Step 1 (types) |
| 3    | WebCrypto backend   | Auth service, store, manager   | Step 1 (types) |
| 4    | CertificateManager  | Auth service, RPC              | Steps 1-3      |
| 5    | Progressive RPC API | HTTP endpoints                 | Steps 1-4      |
| 6    | HTTP endpoints      | Nothing else                   | Steps 1-5      |
| 7    | Auth service wiring | Nothing else                   | Steps 1-6      |
| 8    | Integration test    | Nothing else                   | Steps 1-7      |

A developer can implement and test steps 1-4 in `packages/pki` without
touching any existing code. Steps 5-7 modify existing files. Step 8
validates the full flow.
