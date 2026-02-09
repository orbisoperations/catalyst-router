import argon2 from 'argon2'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'crypto'

/**
 * Hash a password using Argon2id
 *
 * Uses OWASP recommended parameters for Argon2id:
 * - memoryCost: 19456 KiB (19 MiB)
 * - timeCost: 2 iterations
 * - parallelism: 1
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  })
}

/**
 * Verify a password against an Argon2id hash
 *
 * Returns false for any error (invalid hash format, wrong password, etc.)
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}

/**
 * Timing-safe string comparison
 *
 * Prevents timing attacks by ensuring comparison takes constant time
 * regardless of where strings differ.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a comparison to maintain constant-ish time
    // but we know result will be false
    const dummy = Buffer.from(a)
    cryptoTimingSafeEqual(dummy, dummy)
    return false
  }

  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return cryptoTimingSafeEqual(bufA, bufB)
}

/**
 * Dummy hash for timing-safe comparison when user doesn't exist
 *
 * Used to prevent timing attacks that could reveal whether a user exists.
 * Always verify against this when user is not found.
 */
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$dGhpc2lzYWR1bW15c2FsdA$dummyhashvaluethatnevermatchesanything'
