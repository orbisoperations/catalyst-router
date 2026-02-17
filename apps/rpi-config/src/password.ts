/**
 * Password validation matching rpi-image-gen's device-base layer requirements.
 *
 * The regex enforced by rpi-image-gen (layer/base/device-base.yaml):
 *   ^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$
 */

const ALLOWED_SPECIALS = '@$!%*?&'

export const PASSWORD_REQUIREMENTS =
  'Must be 8+ characters with uppercase, lowercase, digit, and special (@$!%*?&).'

/**
 * Validate a password against rpi-image-gen's device-base requirements.
 * Returns an empty array if valid, or a list of human-readable issues.
 */
export function validatePassword(pw: string): string[] {
  const errors: string[] = []

  if (pw.length < 8) {
    errors.push(`Too short (${pw.length} chars, need at least 8)`)
  }
  if (!/[a-z]/.test(pw)) {
    errors.push('Missing lowercase letter')
  }
  if (!/[A-Z]/.test(pw)) {
    errors.push('Missing uppercase letter')
  }
  if (!/\d/.test(pw)) {
    errors.push('Missing digit')
  }
  if (!new RegExp(`[${escapeRegex(ALLOWED_SPECIALS)}]`).test(pw)) {
    errors.push(`Missing special character (one of ${ALLOWED_SPECIALS})`)
  }

  // Check for disallowed characters (only letters, digits, and @$!%*?& are allowed)
  const allowed = new RegExp(`^[A-Za-z\\d${escapeRegex(ALLOWED_SPECIALS)}]+$`)
  if (pw.length > 0 && !allowed.test(pw)) {
    errors.push(
      `Contains characters not allowed by rpi-image-gen (only letters, digits, and ${ALLOWED_SPECIALS})`
    )
  }

  return errors
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
