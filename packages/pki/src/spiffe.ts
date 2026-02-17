import type { ServiceType } from './types.js'

/** Valid SPIFFE service types */
const VALID_SERVICE_TYPES: ReadonlySet<string> = new Set([
  'orchestrator',
  'auth',
  'node',
  'gateway',
  'envoy/app',
  'envoy/transport',
])

/** Parsed SPIFFE ID components */
export interface SpiffeId {
  /** Full SPIFFE URI (e.g., 'spiffe://example.com/orchestrator/node-a') */
  uri: string
  /** Trust domain (e.g., 'example.com') */
  trustDomain: string
  /** Service type (e.g., 'orchestrator') */
  serviceType: ServiceType
  /** Instance identifier (e.g., 'node-a') */
  instanceId: string
}

/**
 * Parse a SPIFFE ID URI into its components.
 *
 * Expected format: spiffe://<trust-domain>/<service-type>/<instance-id>
 * For envoy types: spiffe://<trust-domain>/envoy/<sub-type>/<instance-id>
 *
 * @throws Error if the URI is malformed or has an invalid service type
 */
export function parseSpiffeId(uri: string): SpiffeId {
  if (!uri.startsWith('spiffe://')) {
    throw new Error(`Invalid SPIFFE ID: must start with spiffe://, got "${uri}"`)
  }

  const withoutScheme = uri.slice('spiffe://'.length)
  const slashIndex = withoutScheme.indexOf('/')
  if (slashIndex === -1) {
    throw new Error(`Invalid SPIFFE ID: missing path component in "${uri}"`)
  }

  const trustDomain = withoutScheme.slice(0, slashIndex)
  if (trustDomain.length === 0) {
    throw new Error(`Invalid SPIFFE ID: empty trust domain in "${uri}"`)
  }

  const path = withoutScheme.slice(slashIndex + 1)
  const pathParts = path.split('/')

  // Handle envoy/* service types (3 path parts: envoy, sub-type, instance-id)
  if (pathParts[0] === 'envoy' && pathParts.length >= 3) {
    const serviceType = `envoy/${pathParts[1]}` as ServiceType
    if (!VALID_SERVICE_TYPES.has(serviceType)) {
      throw new Error(`Invalid SPIFFE ID: unknown service type "${serviceType}" in "${uri}"`)
    }
    const instanceId = pathParts.slice(2).join('/')
    if (instanceId.length === 0) {
      throw new Error(`Invalid SPIFFE ID: empty instance ID in "${uri}"`)
    }
    return { uri, trustDomain, serviceType, instanceId }
  }

  // Handle regular service types (2 path parts: service-type, instance-id)
  if (pathParts.length < 2) {
    throw new Error(`Invalid SPIFFE ID: missing instance ID in "${uri}"`)
  }

  const serviceType = pathParts[0] as ServiceType
  if (!VALID_SERVICE_TYPES.has(serviceType)) {
    throw new Error(`Invalid SPIFFE ID: unknown service type "${serviceType}" in "${uri}"`)
  }

  const instanceId = pathParts.slice(1).join('/')
  if (instanceId.length === 0) {
    throw new Error(`Invalid SPIFFE ID: empty instance ID in "${uri}"`)
  }

  return { uri, trustDomain, serviceType, instanceId }
}

/**
 * Build a SPIFFE ID URI from components.
 *
 * @returns A fully qualified SPIFFE URI string
 */
export function buildSpiffeId(
  trustDomain: string,
  serviceType: ServiceType,
  instanceId: string
): string {
  if (trustDomain.length === 0) {
    throw new Error('Trust domain must not be empty')
  }
  if (instanceId.length === 0) {
    throw new Error('Instance ID must not be empty')
  }
  if (!VALID_SERVICE_TYPES.has(serviceType)) {
    throw new Error(`Invalid service type: "${serviceType}"`)
  }
  return `spiffe://${trustDomain}/${serviceType}/${instanceId}`
}

/**
 * Validate that a string is a well-formed SPIFFE ID.
 * Returns true if valid, false otherwise.
 */
export function isValidSpiffeId(uri: string): boolean {
  try {
    parseSpiffeId(uri)
    return true
  } catch {
    return false
  }
}
