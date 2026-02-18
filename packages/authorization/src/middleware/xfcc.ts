import type { Context, MiddlewareHandler } from 'hono'

/**
 * Parsed identity from an Envoy X-Forwarded-Client-Cert (XFCC) header.
 *
 * Envoy populates this header when `forward_client_cert_details` is set to
 * `SANITIZE_SET`. Fields are extracted from the presenting client certificate.
 */
export interface XfccIdentity {
  /** SHA-256 fingerprint of the client certificate (always present in XFCC). */
  hash?: string
  /** SPIFFE URI SAN from the client certificate. */
  uri?: string
  /** Subject DN from the client certificate. */
  subject?: string
  /** DNS SAN entries from the client certificate. */
  dns?: string[]
}

/**
 * Parse a single XFCC element (one client cert's fields).
 *
 * Format: `Key1=Value1;Key2=Value2`
 * Values may be quoted: `Subject="CN=foo,O=bar"`
 */
function parseXfccElement(element: string): XfccIdentity {
  const identity: XfccIdentity = {}
  const dnsEntries: string[] = []

  // Match key=value pairs, handling quoted values
  const pairRegex = /(\w+)=(?:"([^"]*)"|([^;]*))/g
  let match: RegExpExecArray | null

  while ((match = pairRegex.exec(element)) !== null) {
    const key = match[1].toLowerCase()
    const value = match[2] ?? match[3]

    switch (key) {
      case 'hash':
        identity.hash = value
        break
      case 'uri':
        identity.uri = value
        break
      case 'subject':
        identity.subject = value
        break
      case 'dns':
        dnsEntries.push(value)
        break
    }
  }

  if (dnsEntries.length > 0) {
    identity.dns = dnsEntries
  }

  return identity
}

/**
 * Split XFCC header on commas that are not inside quoted values.
 * Comma within quotes (e.g. Subject="CN=foo,O=bar") should not split.
 */
function splitXfccElements(headerValue: string): string[] {
  const elements: string[] = []
  let current = ''
  let inQuotes = false

  for (const ch of headerValue) {
    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
    } else if (ch === ',' && !inQuotes) {
      elements.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) {
    elements.push(current.trim())
  }

  return elements
}

/**
 * Parse the `X-Forwarded-Client-Cert` header value.
 *
 * Multiple client certs are comma-separated (proxy chain). Returns the first
 * element, which is the immediate client's cert (Envoy's `SANITIZE_SET` mode
 * strips and rebuilds the header, so there's only one element).
 */
export function parseXfcc(headerValue: string): XfccIdentity | undefined {
  if (!headerValue) return undefined

  const elements = splitXfccElements(headerValue)
  const firstElement = elements[0]
  if (!firstElement) return undefined

  return parseXfccElement(firstElement)
}

/**
 * Hono middleware that parses the XFCC header and sets the identity in context.
 *
 * When traffic arrives through Envoy with mTLS, the XFCC header contains
 * the client certificate's fingerprint, SPIFFE URI, subject, and DNS SANs.
 *
 * Localhost callers (not through Envoy) won't have an XFCC header — the
 * middleware simply sets `xfcc` to `undefined` and continues.
 */
export function xfccMiddleware(): MiddlewareHandler {
  return async (c: Context, next) => {
    const header = c.req.header('x-forwarded-client-cert')
    const identity = header ? parseXfcc(header) : undefined
    c.set('xfcc', identity)
    await next()
  }
}

/**
 * Result of certificate-bound token validation.
 */
export type CertBindingResult =
  | { bound: true }
  | { bound: false; reason: string }
  | { bound: 'skipped'; reason: string }

/**
 * Validate that a JWT's certificate binding matches the presenting certificate.
 *
 * Compares the JWT's `cnf.x5t#S256` claim (RFC 8705) against the XFCC `Hash`
 * field from Envoy's TLS termination.
 *
 * Returns:
 * - `{ bound: true }` — fingerprints match
 * - `{ bound: false, reason }` — fingerprints mismatch (reject the request)
 * - `{ bound: 'skipped', reason }` — validation skipped (no XFCC or no cnf claim)
 *
 * When XFCC is absent (localhost callers), validation is skipped — this is
 * expected for intra-node communication that doesn't go through Envoy.
 */
export function validateCertBinding(
  jwtPayload: Record<string, unknown>,
  xfcc: XfccIdentity | undefined
): CertBindingResult {
  // No XFCC = localhost caller, skip validation
  if (!xfcc || !xfcc.hash) {
    return { bound: 'skipped', reason: 'No XFCC header (localhost caller)' }
  }

  // Extract cnf.x5t#S256 from JWT payload
  const cnf = jwtPayload.cnf as Record<string, unknown> | undefined
  if (!cnf) {
    return { bound: 'skipped', reason: 'JWT has no cnf claim' }
  }

  const expectedHash = cnf['x5t#S256'] as string | undefined
  if (!expectedHash) {
    return { bound: 'skipped', reason: 'JWT cnf has no x5t#S256 field' }
  }

  // Compare fingerprints (case-insensitive for hex)
  if (xfcc.hash.toLowerCase() === expectedHash.toLowerCase()) {
    return { bound: true }
  }

  return {
    bound: false,
    reason: `Certificate fingerprint mismatch: XFCC=${xfcc.hash}, JWT cnf=${expectedHash}`,
  }
}
