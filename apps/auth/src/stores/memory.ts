import type { User, CreateUserInput } from '../models/user.js'
import { generateUserId } from '../models/user.js'
import type { UserStore } from './types.js'

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
