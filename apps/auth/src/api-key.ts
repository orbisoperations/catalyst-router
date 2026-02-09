import { randomBytes } from 'crypto'

/**
 * Base62 character set (alphanumeric, URL-safe)
 */
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * Encode bytes to base62 string
 */
export function encodeBase62(bytes: Uint8Array): string {
  let result = ''
  let value = BigInt(0)

  // Convert bytes to big integer
  for (const byte of bytes) {
    value = (value << BigInt(8)) | BigInt(byte)
  }

  // Convert to base62
  if (value === BigInt(0)) {
    return BASE62_CHARS[0]
  }

  while (value > BigInt(0)) {
    result = BASE62_CHARS[Number(value % BigInt(62))] + result
    value = value / BigInt(62)
  }

  return result
}

export interface GeneratedApiKey {
  /** Full API key (prefix + secret) - only returned once */
  key: string
  /** Key prefix for lookup (e.g., cat_sk_dflt_) */
  prefix: string
  /** Secret portion of the key */
  secret: string
}

/**
 * Generate a new API key
 *
 * Format: cat_sk_{orgId}_{base62Secret}
 * - cat_sk_ = Catalyst secret key prefix
 * - {orgId} = Organization identifier (e.g., 'dflt' for default)
 * - {secret} = 24 random bytes encoded as base62
 *
 * @param orgId - Short org identifier (max 10 chars, lowercase alphanumeric)
 */
export function generateApiKey(orgId: string): GeneratedApiKey {
  const secretBytes = randomBytes(24)
  const secret = encodeBase62(secretBytes)
  const prefix = `cat_sk_${orgId}_`
  const key = `${prefix}${secret}`

  return { key, prefix, secret }
}

/**
 * Extract prefix from an API key
 *
 * @returns The prefix (e.g., 'cat_sk_dflt_') or null if invalid format
 */
export function extractPrefix(key: string): string | null {
  const match = key.match(/^(cat_sk_[a-z0-9]+_)/)
  if (!match) {
    return null
  }
  return match[1]
}
