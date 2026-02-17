# @catalyst/pki

X.509 certificate lifecycle management for Catalyst services. Provides a
Certificate Authority (CA) hierarchy, CSR signing, certificate storage, SPIFFE
identity utilities, and a deny list for passive revocation.

## Architecture

```
                  +============================+
                  |     CertificateManager     |
                  |  (facade — config-driven)  |
                  +============================+
                     /                     \
          +================+       +====================+
          | ICertificateStore|       | ISigningBackend    |
          | (persistence)  |       | (crypto operations) |
          +================+       +====================+
                  |                         |
     +========================+   +========================+
     | BunSqliteCertificateStore|   | WebCryptoSigningBackend |
     | (SQLite via bun:sqlite)|   | (@peculiar/x509 +      |
     |                        |   |  Bun SubtleCrypto)     |
     +========================+   +========================+
```

- **CertificateManager** is the main entry point. It wires together storage
  and signing behind a single API, similar to `JWTTokenFactory` from
  `@catalyst/authorization`.
- **ISigningBackend** abstracts crypto operations so the signing
  implementation can be swapped (Phase 1: WebCrypto, Phase 2: AWS KMS /
  GCP Cloud KMS).
- **ICertificateStore** abstracts certificate metadata persistence
  (Phase 1: SQLite).

## Usage

### Production

```typescript
import {
  CertificateManager,
  BunSqliteCertificateStore,
  WebCryptoSigningBackend,
} from '@catalyst/pki'

const store = new BunSqliteCertificateStore('/data/pki/certs.db')
const backend = new WebCryptoSigningBackend()
const manager = new CertificateManager(store, backend, {
  trustDomain: 'acme.catalyst.io',
  svidTtlSeconds: 3600, // 1 hour (default)
  maxSvidTtlSeconds: 86400, // 24 hour hard cap
})

// Initialize the CA hierarchy (idempotent — safe to call on every startup)
const { rootFingerprint, servicesCaFingerprint, transportCaFingerprint } =
  await manager.initialize()
```

### Testing (Ephemeral)

```typescript
import { CertificateManager } from '@catalyst/pki'

// In-memory SQLite, no files on disk
const manager = CertificateManager.ephemeral({
  trustDomain: 'test.example.com',
})
await manager.initialize()
```

### Signing a CSR

```typescript
import * as x509 from '@peculiar/x509'

// 1. Generate a key pair locally
const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, [
  'sign',
  'verify',
])

// 2. Build a CSR with a SPIFFE URI SAN
const csr = await x509.Pkcs10CertificateRequestGenerator.create({
  name: 'CN=node-a.prod.acme.io',
  keys: keyPair,
  signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
  extensions: [
    new x509.SubjectAlternativeNameExtension([
      { type: 'url', value: 'spiffe://acme.catalyst.io/orchestrator/node-a.prod.acme.io' },
      { type: 'dns', value: 'node-a.prod.acme.io' },
    ]),
  ],
})

// 3. Submit CSR to the CertificateManager
const result = await manager.signCSR({
  csrPem: csr.toString('pem'),
  serviceType: 'orchestrator',
  instanceId: 'node-a.prod.acme.io',
  ttlSeconds: 3600, // optional, defaults to configured svidTtlSeconds
})

// result.certificatePem  — signed leaf certificate (PEM)
// result.chain           — [intermediate CA PEM, root CA PEM]
// result.fingerprint     — SHA-256 fingerprint (base64url)
// result.expiresAt       — ISO 8601 expiration timestamp
// result.renewAfter      — ISO 8601 recommended renewal time (50% lifetime)
```

### SPIFFE Utilities

```typescript
import { buildSpiffeId, parseSpiffeId, isValidSpiffeId } from '@catalyst/pki'

const uri = buildSpiffeId('acme.catalyst.io', 'orchestrator', 'node-a')
// => 'spiffe://acme.catalyst.io/orchestrator/node-a'

const parsed = parseSpiffeId(uri)
// => { uri, trustDomain: 'acme.catalyst.io', serviceType: 'orchestrator', instanceId: 'node-a' }

isValidSpiffeId('spiffe://acme.catalyst.io/auth/auth-a') // true
isValidSpiffeId('https://example.com') // false
```

### Deny List (Passive Revocation)

```typescript
// Deny a SPIFFE identity — blocks future certificate issuance
const { expiringCerts } = await manager.denyIdentity(
  'spiffe://acme.catalyst.io/orchestrator/node-a',
  'Key compromise — incident #1234'
)
// expiringCerts lists active certs that will expire naturally

// Re-enable
await manager.allowIdentity('spiffe://acme.catalyst.io/orchestrator/node-a')

// List denied identities
const denied = await manager.listDeniedIdentities()
```

### CA Bundle and Status

```typescript
// Get trust bundles for distribution
const bundle = await manager.getCaBundle()
// bundle.servicesBundle  — PEM array for control-plane trust
// bundle.transportBundle — PEM array for data-plane trust
// bundle.version         — ETag for caching

// Get PKI health status
const status = await manager.getStatus()
// status.status           — 'healthy' | 'degraded' | 'uninitialized'
// status.activeCertCount  — number of active end-entity certs
// status.warnings         — e.g., ['Services CA expires within 30 days']
```

## Public API

### Classes

| Export                      | Description                                    |
| :-------------------------- | :--------------------------------------------- |
| `CertificateManager`        | Main facade for all PKI operations             |
| `BunSqliteCertificateStore` | SQLite-backed certificate and deny list store  |
| `WebCryptoSigningBackend`   | ECDSA P-384 signing via `@peculiar/x509` + Bun |

### Functions

| Export            | Description                            |
| :---------------- | :------------------------------------- |
| `buildSpiffeId`   | Construct a SPIFFE URI from components |
| `parseSpiffeId`   | Parse a SPIFFE URI into components     |
| `isValidSpiffeId` | Validate a SPIFFE URI string           |

### Interfaces

| Export              | Description                                      |
| :------------------ | :----------------------------------------------- |
| `ICertificateStore` | Storage abstraction for certificates + deny list |
| `ISigningBackend`   | Crypto abstraction (WebCrypto / KMS)             |
| `SignCSRRequest`    | Input for `CertificateManager.signCSR()`         |
| `SignCSRResult`     | Output from `CertificateManager.signCSR()`       |
| `CaBundleResponse`  | Trust bundle response from `getCaBundle()`       |
| `PkiStatusResponse` | Health status from `getStatus()`                 |
| `CertificateRecord` | Persisted certificate metadata record            |
| `DenyListEntry`     | Denied SPIFFE identity record                    |
| `SpiffeId`          | Parsed SPIFFE ID components                      |

### Zod Schemas

| Export                       | Description                         |
| :--------------------------- | :---------------------------------- |
| `SignCSRRequestSchema`       | Validates CSR signing request input |
| `DenyIdentityRequestSchema`  | Validates deny identity request     |
| `AllowIdentityRequestSchema` | Validates allow identity request    |

## Tests

```bash
# Run all tests
bun test packages/pki

# Unit tests only
cd packages/pki && bun run test:unit

# Integration tests only
cd packages/pki && bun run test:integration
```

## Related Documentation

- [ADR 0011: PKI Hierarchy and Certificate Profiles](../../docs/adr/0011-pki-hierarchy-and-certificate-profiles.md)
- [PKI Primer](../../docs/pki/pki-primer.md) — Educational background on PKI concepts
- [SPIFFE Primer](../../docs/pki/spiffe-primer.md) — What SPIFFE is and how Catalyst uses it
- [Bun TLS Cookbook](../../docs/pki/bun-tls-cookbook.md) — Loading certs into Bun.serve() and fetch()
- [Interaction Flows](../../docs/pki/interaction-flows.md) — Step-by-step PKI flows
- [Operations Guide](../../docs/pki/operations-guide.md) — Day-to-day operations and troubleshooting
- [Implementation Plan](../../docs/pki/implementation-plan.md) — File-by-file build plan
