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

/** OID for the Name Constraints extension (RFC 5280 Section 4.2.1.10) */
const NAME_CONSTRAINTS_OID = '2.5.29.30'

/**
 * Encode a DER length field (definite form).
 * Supports lengths up to 65535.
 */
function derEncodeLength(len: number): number[] {
  if (len < 128) return [len]
  if (len < 256) return [0x81, len]
  if (len < 65536) return [0x82, (len >> 8) & 0xff, len & 0xff]
  throw new Error(`DER length too large: ${len}`)
}

/**
 * Build a DER-encoded Name Constraints extension value (RFC 5280 Section 4.2.1.10).
 *
 * ASN.1 structure:
 *   NameConstraints ::= SEQUENCE {
 *     permittedSubtrees [0] GeneralSubtrees OPTIONAL
 *   }
 *   GeneralSubtrees ::= SEQUENCE SIZE (1..MAX) OF GeneralSubtree
 *   GeneralSubtree ::= SEQUENCE { base GeneralName }
 *   GeneralName ::= CHOICE { uniformResourceIdentifier [6] IA5String }
 *
 * @peculiar/x509 v1.14.x does not export NameConstraintsExtension,
 * so we encode the DER manually and use the raw Extension constructor.
 */
function buildNameConstraintsDer(permittedUris: string[]): Uint8Array {
  // Build each GeneralSubtree SEQUENCE
  const subtrees = permittedUris.map((uri) => {
    const uriBytes = new TextEncoder().encode(uri)
    // GeneralName: uniformResourceIdentifier [6] IMPLICIT IA5String
    const generalName = new Uint8Array([0x86, ...derEncodeLength(uriBytes.length), ...uriBytes])
    // GeneralSubtree SEQUENCE { base: GeneralName }
    const subtreeContent = [...generalName]
    return new Uint8Array([0x30, ...derEncodeLength(subtreeContent.length), ...subtreeContent])
  })

  // permittedSubtrees [0] IMPLICIT SEQUENCE OF GeneralSubtree
  const permittedContent = subtrees.reduce<number[]>((acc, s) => [...acc, ...s], [])
  const permitted = new Uint8Array([
    0xa0,
    ...derEncodeLength(permittedContent.length),
    ...permittedContent,
  ])

  // NameConstraints SEQUENCE { permittedSubtrees }
  const seqContent = [...permitted]
  return new Uint8Array([0x30, ...derEncodeLength(seqContent.length), ...seqContent])
}

/**
 * WebCrypto-based signing backend for X.509 certificate operations.
 *
 * Uses `@peculiar/x509` for certificate generation and Bun's built-in
 * `crypto.subtle` for key generation and fingerprinting. This backend is
 * the Phase 1 implementation; Phase 2 will add cloud KMS backends
 * (AWS KMS, GCP Cloud KMS) behind the same `ISigningBackend` interface.
 *
 * All certificates use ECDSA P-384 with SHA-384 signatures per ADR 0011.
 */
export class WebCryptoSigningBackend implements ISigningBackend {
  /**
   * Generate an ECDSA P-384 key pair suitable for signing or as a subject key.
   * Keys are extractable so they can be exported/persisted.
   */
  async generateKeyPair(): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey(EC_ALGORITHM, true, ['sign', 'verify'])
  }

  /**
   * Sign (create) an X.509 certificate with the given parameters.
   *
   * Supports all certificate profiles defined in ADR 0011:
   * - Root CA (self-signed, pathlen:1, keyCertSign + cRLSign)
   * - Intermediate CA (signed by root, pathlen:0, name constraints, keyCertSign + cRLSign)
   * - End-entity (signed by intermediate, CA:FALSE, digitalSignature, SPIFFE URI SAN)
   *
   * Includes SKI on all certs and AKI on all non-self-signed certs per ADR 0011 Sections 3.1-3.3.
   */
  async signCertificate(params: SignCertificateParams): Promise<string> {
    const extensions: x509.Extension[] = []

    // Basic Constraints (critical)
    // Root CA: CA:TRUE, pathlen:1
    // Intermediate CA: CA:TRUE, pathlen:0
    // End-entity: CA:FALSE (pathLenConstraint omitted)
    extensions.push(
      new x509.BasicConstraintsExtension(
        params.isCa,
        params.isCa ? params.pathLenConstraint : undefined,
        true // critical
      )
    )

    // Key Usage (critical)
    // CAs: keyCertSign + cRLSign
    // End-entities: digitalSignature
    let keyUsageFlags = 0
    if (params.keyUsage.digitalSignature) keyUsageFlags |= x509.KeyUsageFlags.digitalSignature
    if (params.keyUsage.keyCertSign) keyUsageFlags |= x509.KeyUsageFlags.keyCertSign
    if (params.keyUsage.crlSign) keyUsageFlags |= x509.KeyUsageFlags.cRLSign
    extensions.push(new x509.KeyUsagesExtension(keyUsageFlags, true))

    // Extended Key Usage (non-critical, end-entity only)
    // Most services: serverAuth + clientAuth
    // Gateway: serverAuth only (ADR 0011 Section 3.7)
    if (params.extKeyUsage && params.extKeyUsage.length > 0) {
      const oids: string[] = []
      for (const eku of params.extKeyUsage) {
        if (eku === 'serverAuth') oids.push(x509.ExtendedKeyUsage.serverAuth)
        if (eku === 'clientAuth') oids.push(x509.ExtendedKeyUsage.clientAuth)
      }
      extensions.push(new x509.ExtendedKeyUsageExtension(oids, false))
    }

    // Subject Alternative Names (non-critical)
    // End-entity: exactly one SPIFFE URI SAN (authoritative identity) + optional DNS SANs
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

    // Subject Key Identifier (non-critical, ALL certs)
    // Required by ADR 0011 Section 3.1 -- derived from the subject public key hash.
    // Without SKI, CA rotation fails: verifiers cannot distinguish two intermediates
    // with the same subject CN during the grace period.
    extensions.push(await x509.SubjectKeyIdentifierExtension.create(params.subjectPublicKey))

    // Authority Key Identifier (non-critical, non-self-signed certs only)
    // Required by ADR 0011 Sections 3.2 and 3.3 for intermediates + end-entities.
    // Links each cert to its issuer's SKI, enabling path building during CA rotation.
    if (params.signingCert) {
      const issuerCert = new x509.X509Certificate(params.signingCert)
      extensions.push(await x509.AuthorityKeyIdentifierExtension.create(issuerCert))
    }

    // Name Constraints (critical, intermediate CAs only)
    // ADR 0011 Sections 3.2 and 3.3:
    // - Services CA: permits orchestrator/, auth/, node/, gateway/ SPIFFE URIs
    // - Transport CA: permits envoy/ SPIFFE URIs
    // This security boundary prevents a compromised Services CA from issuing envoy certs.
    //
    // @peculiar/x509 v1.14.x does not export NameConstraintsExtension, so we
    // build the DER manually. See buildNameConstraintsDer() above.
    if (params.nameConstraints && params.nameConstraints.permittedUris.length > 0) {
      const der = buildNameConstraintsDer(params.nameConstraints.permittedUris)
      extensions.push(new x509.Extension(NAME_CONSTRAINTS_OID, true, der))
    }

    // Generate serial number (hex string, unique per cert)
    const serialNumber = params.serialNumber ?? crypto.randomUUID().replace(/-/g, '')

    // Determine issuer DN: for self-signed certs, issuer = subject.
    // For signed certs, extract issuer from the signing certificate.
    const isSelfSigned = !params.signingCert
    const issuerDn = isSelfSigned
      ? `CN=${params.subjectCN}`
      : new x509.X509Certificate(params.signingCert).subject

    // Create the certificate
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber,
      subject: `CN=${params.subjectCN}`,
      issuer: issuerDn,
      notBefore: params.notBefore,
      notAfter: params.notAfter,
      signingAlgorithm: SIGNING_ALGORITHM,
      publicKey: params.subjectPublicKey,
      signingKey: params.signingKey,
      extensions,
    })

    return cert.toString('pem')
  }

  /**
   * Export a CryptoKey private key to PKCS#8 PEM format.
   */
  async exportPrivateKeyPem(key: CryptoKey): Promise<string> {
    const exported = await crypto.subtle.exportKey('pkcs8', key)
    return x509.PemConverter.encode(exported, 'PRIVATE KEY')
  }

  /**
   * Import a PKCS#8 PEM private key back to a CryptoKey.
   * The key is imported as extractable with 'sign' usage.
   */
  async importPrivateKeyPem(pem: string): Promise<CryptoKey> {
    const der = x509.PemConverter.decode(pem)[0]
    return crypto.subtle.importKey('pkcs8', der, EC_ALGORITHM, true, ['sign'])
  }

  /**
   * Export a CryptoKey public key to SPKI PEM format.
   */
  async exportPublicKeyPem(key: CryptoKey): Promise<string> {
    const exported = await crypto.subtle.exportKey('spki', key)
    return x509.PemConverter.encode(exported, 'PUBLIC KEY')
  }

  /**
   * Compute the SHA-256 fingerprint of a DER-encoded certificate.
   *
   * Returns base64url encoding with no padding (RFC 4648 Section 5),
   * matching the format required by RFC 8705 `cnf.x5t#S256` claims
   * and the `CertificateRecord.fingerprint` field.
   */
  async computeFingerprint(certDer: ArrayBuffer): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', certDer)
    // Base64url encode, no padding (RFC 4648 Section 5)
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }
}
