import type { User, CreateUserInput } from '../models/user.js'
import { generateUserId } from '../models/user.js'
import type { ServiceAccount, CreateServiceAccountInput } from '../models/service-account.js'
import { generateServiceAccountId } from '../models/service-account.js'
import type { BootstrapState } from '../models/bootstrap.js'
import type { UserStore, ServiceAccountStore, BootstrapStore } from './types.js'

/**
 * In-memory UserStore implementation
 *
 * Suitable for testing and single-instance deployments.
 */
export class InMemoryUserStore implements UserStore {
  private users = new Map<string, User>()

  async create(input: CreateUserInput): Promise<User> {
    const id = generateUserId()
    const user: User = {
      ...input,
      id,
      email: input.email.toLowerCase().trim(),
      createdAt: new Date(),
    }
    this.users.set(id, user)
    return user
  }

  async findById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null
  }

  async findByEmail(email: string, orgId = 'default'): Promise<User | null> {
    const normalizedEmail = email.toLowerCase().trim()
    for (const user of this.users.values()) {
      if (user.email === normalizedEmail && user.orgId === orgId) {
        return user
      }
    }
    return null
  }

  async update(id: string, updates: Partial<User>): Promise<User> {
    const user = this.users.get(id)
    if (!user) {
      throw new Error('User not found')
    }
    const updated = { ...user, ...updates }
    this.users.set(id, updated)
    return updated
  }

  async delete(id: string): Promise<void> {
    this.users.delete(id)
  }

  async list(orgId?: string): Promise<User[]> {
    const users = Array.from(this.users.values())
    return orgId ? users.filter((u) => u.orgId === orgId) : users
  }
}

/**
 * In-memory ServiceAccountStore implementation
 */
export class InMemoryServiceAccountStore implements ServiceAccountStore {
  private accounts = new Map<string, ServiceAccount>()

  async create(input: CreateServiceAccountInput): Promise<ServiceAccount> {
    const id = generateServiceAccountId()
    const sa: ServiceAccount = {
      ...input,
      id,
      createdAt: new Date(),
    }
    this.accounts.set(id, sa)
    return sa
  }

  async findById(id: string): Promise<ServiceAccount | null> {
    return this.accounts.get(id) ?? null
  }

  async findByPrefix(prefix: string): Promise<ServiceAccount | null> {
    for (const sa of this.accounts.values()) {
      if (sa.keyPrefix === prefix) {
        return sa
      }
    }
    return null
  }

  async findByName(name: string, orgId = 'default'): Promise<ServiceAccount | null> {
    for (const sa of this.accounts.values()) {
      if (sa.name === name && sa.orgId === orgId) {
        return sa
      }
    }
    return null
  }

  async delete(id: string): Promise<void> {
    this.accounts.delete(id)
  }

  async list(orgId?: string): Promise<ServiceAccount[]> {
    const accounts = Array.from(this.accounts.values())
    return orgId ? accounts.filter((sa) => sa.orgId === orgId) : accounts
  }
}

/**
 * In-memory BootstrapStore implementation
 */
export class InMemoryBootstrapStore implements BootstrapStore {
  private state: BootstrapState | null = null

  async get(): Promise<BootstrapState | null> {
    return this.state
  }

  async set(state: BootstrapState): Promise<void> {
    this.state = state
  }

  async markUsed(adminId: string): Promise<void> {
    if (this.state) {
      this.state.used = true
      this.state.createdAdminId = adminId
    }
  }
}
