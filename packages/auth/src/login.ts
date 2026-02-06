import type { UserStore } from './stores/types.js'
import type { TokenManager } from '@catalyst/authorization'
import { verifyPassword, DUMMY_HASH } from './password.js'

/**
 * Default JWT expiry: 1 hour
 */
const DEFAULT_TOKEN_EXPIRY = '1h'

export interface LoginInput {
  /** User email address */
  email: string
  /** User password */
  password: string
}

export interface LoginResult {
  success: boolean
  token?: string
  expiresAt?: Date
  error?: string
}

/**
 * LoginService handles email/password authentication
 *
 * Security features:
 * - Timing-safe password verification (always runs Argon2 even for unknown emails)
 * - Normalized email lookup (case-insensitive)
 * - Updates lastLoginAt on successful login
 */
export class LoginService {
  constructor(
    private userStore: UserStore,
    private tokenManager: TokenManager
  ) { }

  /**
   * Authenticate user and issue JWT
   */
  async login(input: LoginInput): Promise<LoginResult> {
    const email = input.email.toLowerCase().trim()
    const user = await this.userStore.findByEmail(email)

    // Timing-safe: always verify password even if user not found
    // This prevents timing attacks that reveal email existence
    const hashToVerify = user?.passwordHash ?? DUMMY_HASH
    const valid = await verifyPassword(hashToVerify, input.password)

    if (!user || !valid) {
      return { success: false, error: 'Invalid credentials' }
    }

    // Update lastLoginAt
    await this.userStore.update(user.id, { lastLoginAt: new Date() })

    // Issue JWT with user claims
    const token = await this.tokenManager.mint({
      subject: user.id,
      expiresIn: DEFAULT_TOKEN_EXPIRY,
      entity: {
        id: user.id,
        name: user.email,
        type: 'user',
      },
      claims: {
        roles: user.roles,
        orgId: user.orgId,
      },
    })

    // Calculate expiry (1 hour from now)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)

    return { success: true, token, expiresAt }
  }
}
