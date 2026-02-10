import type { ServiceAccountStore } from './stores/types.js'
import { generateApiKey, extractPrefix } from './api-key.js'
import { hashPassword, verifyPassword, DUMMY_HASH } from './password.js'

/**
 * Maximum API key expiry: 1 year (365 days)
 */
const MAX_EXPIRY_DAYS = 365

export interface CreateServiceAccountInput {
  name: string
  roles: string[]
  orgId: string
  /** Expiry in days (max 365) */
  expiresInDays: number
  createdBy: string
}

export interface CreateServiceAccountResult {
  success: boolean
  serviceAccountId?: string
  /** Plaintext API key - only returned once! */
  apiKey?: string
  expiresAt?: Date
  error?: string
}

export interface AuthContext {
  userId: string
  roles: string[]
  orgId: string
}

export interface AuthenticateResult {
  success: boolean
  auth?: AuthContext
  error?: string
}

export interface ServiceAccountInfo {
  id: string
  name: string
  roles: string[]
  orgId: string
  keyPrefix: string
  expiresAt: Date
  createdAt: Date
  createdBy: string
}

/**
 * ApiKeyService handles service account management and API key authentication
 */
export class ApiKeyService {
  constructor(private saStore: ServiceAccountStore) {}

  /**
   * Create a new service account with API key
   *
   * @returns The plaintext API key (only returned once!)
   */
  async createServiceAccount(
    input: CreateServiceAccountInput
  ): Promise<CreateServiceAccountResult> {
    // Validate expiry
    if (input.expiresInDays > MAX_EXPIRY_DAYS) {
      return { success: false, error: 'Expiry cannot exceed 1 year' }
    }

    // Check for duplicate name
    const existing = await this.saStore.findByName(input.name, input.orgId)
    if (existing) {
      return { success: false, error: 'Service account with this name already exists' }
    }

    // Generate API key
    const orgShort = input.orgId === 'default' ? 'dflt' : input.orgId.slice(0, 10)
    const { key, prefix } = generateApiKey(orgShort)

    // Hash the full key for storage
    const apiKeyHash = await hashPassword(key)

    // Calculate expiry
    const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)

    // Create service account
    const sa = await this.saStore.create({
      name: input.name,
      apiKeyHash,
      keyPrefix: prefix,
      roles: input.roles,
      orgId: input.orgId,
      expiresAt,
      createdBy: input.createdBy,
    })

    return {
      success: true,
      serviceAccountId: sa.id,
      apiKey: key,
      expiresAt,
    }
  }

  /**
   * Authenticate an API key
   *
   * Security: Uses timing-safe comparison via Argon2 verify
   */
  async authenticateApiKey(apiKey: string): Promise<AuthenticateResult> {
    // Extract prefix
    const prefix = extractPrefix(apiKey)
    if (!prefix) {
      // Still do a hash verify to maintain constant time
      await verifyPassword(DUMMY_HASH, apiKey)
      return { success: false, error: 'Invalid API key' }
    }

    // Find SA by prefix
    const sa = await this.saStore.findByPrefix(prefix)
    if (!sa) {
      // Timing-safe: verify against dummy hash
      await verifyPassword(DUMMY_HASH, apiKey)
      return { success: false, error: 'Invalid API key' }
    }

    // Check expiry before verifying (still do verify for timing safety)
    const now = new Date()
    if (now > sa.expiresAt) {
      await verifyPassword(sa.apiKeyHash, apiKey)
      return { success: false, error: 'API key expired' }
    }

    // Verify key
    const valid = await verifyPassword(sa.apiKeyHash, apiKey)
    if (!valid) {
      return { success: false, error: 'Invalid API key' }
    }

    return {
      success: true,
      auth: {
        userId: sa.id,
        roles: sa.roles,
        orgId: sa.orgId,
      },
    }
  }

  /**
   * List service accounts for an org (without sensitive data)
   */
  async listServiceAccounts(orgId: string): Promise<ServiceAccountInfo[]> {
    const accounts = await this.saStore.list(orgId)
    return accounts.map((sa) => ({
      id: sa.id,
      name: sa.name,
      roles: sa.roles,
      orgId: sa.orgId,
      keyPrefix: sa.keyPrefix,
      expiresAt: sa.expiresAt,
      createdAt: sa.createdAt,
      createdBy: sa.createdBy,
    }))
  }

  /**
   * Delete a service account
   */
  async deleteServiceAccount(id: string): Promise<void> {
    await this.saStore.delete(id)
  }
}
