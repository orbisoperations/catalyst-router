import { randomBytes } from 'crypto'
import type { UserStore, BootstrapStore } from './stores/types.js'
import { hashPassword, verifyPassword } from './password.js'

/**
 * Bootstrap token default expiry: 24 hours
 */
const DEFAULT_BOOTSTRAP_EXPIRY_MS = 24 * 60 * 60 * 1000

export interface InitializeBootstrapOptions {
  /** Token expiry in milliseconds (default: 24 hours) */
  expiresInMs?: number
}

export interface InitializeBootstrapResult {
  /** The plaintext bootstrap token (only returned once!) */
  token: string
  /** When the token expires */
  expiresAt: Date
}

export interface CreateFirstAdminInput {
  /** The bootstrap token */
  token: string
  /** Admin email address */
  email: string
  /** Admin password (will be hashed) */
  password: string
}

export interface CreateFirstAdminResult {
  success: boolean
  userId?: string
  error?: string
}

export interface BootstrapStatus {
  initialized: boolean
  used: boolean
}

/**
 * BootstrapService handles the first-admin creation flow
 *
 * Flow:
 * 1. On first deployment, initializeBootstrap() generates a one-time token
 * 2. Token is displayed to operator (e.g., in logs or startup output)
 * 3. Operator calls createFirstAdmin() with the token + admin credentials
 * 4. Token is marked as used, preventing further admin creation via bootstrap
 */
export class BootstrapService {
  constructor(
    private userStore: UserStore,
    private bootstrapStore: BootstrapStore
  ) {}

  /**
   * Initialize bootstrap state with a new token
   *
   * @throws Error if bootstrap already initialized
   */
  async initializeBootstrap(
    options: InitializeBootstrapOptions = {}
  ): Promise<InitializeBootstrapResult> {
    const existing = await this.bootstrapStore.get()
    if (existing) {
      throw new Error('Bootstrap already initialized')
    }

    const expiresInMs = options.expiresInMs ?? DEFAULT_BOOTSTRAP_EXPIRY_MS
    const token = randomBytes(32).toString('hex')
    const tokenHash = await hashPassword(token)
    const expiresAt = new Date(Date.now() + expiresInMs)

    await this.bootstrapStore.set({
      tokenHash,
      expiresAt,
      used: false,
    })

    return { token, expiresAt }
  }

  /**
   * Create the first admin user using the bootstrap token
   */
  async createFirstAdmin(input: CreateFirstAdminInput): Promise<CreateFirstAdminResult> {
    const state = await this.bootstrapStore.get()

    if (!state) {
      return { success: false, error: 'Bootstrap not initialized' }
    }

    if (state.used) {
      return { success: false, error: 'Bootstrap already used' }
    }

    // Check expiry before verifying (timing-safe)
    const now = new Date()
    if (now > state.expiresAt) {
      // Still verify to prevent timing attacks revealing expiry status
      await verifyPassword(state.tokenHash, input.token)
      return { success: false, error: 'Invalid or expired bootstrap token' }
    }

    // Verify token (timing-safe via Argon2)
    const valid = await verifyPassword(state.tokenHash, input.token)
    if (!valid) {
      return { success: false, error: 'Invalid or expired bootstrap token' }
    }

    // Create admin user
    const passwordHash = await hashPassword(input.password)
    const user = await this.userStore.create({
      email: input.email.toLowerCase().trim(),
      passwordHash,
      roles: ['admin'],
      orgId: 'default',
    })

    // Mark bootstrap as used
    await this.bootstrapStore.markUsed(user.id)

    return { success: true, userId: user.id }
  }

  /**
   * Get bootstrap status (does not reveal token)
   */
  async getBootstrapStatus(): Promise<BootstrapStatus> {
    const state = await this.bootstrapStore.get()

    return {
      initialized: state !== null,
      used: state?.used ?? false,
    }
  }
}
