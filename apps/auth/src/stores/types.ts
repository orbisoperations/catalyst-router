import type { User, CreateUserInput } from '../models/user.js'

/**
 * UserStore interface - persistence for User entities
 */
export interface UserStore {
  create(user: CreateUserInput): Promise<User>
  findById(id: string): Promise<User | null>
  findByEmail(email: string, orgId?: string): Promise<User | null>
  update(id: string, updates: Partial<User>): Promise<User>
  delete(id: string): Promise<void>
  list(orgId?: string): Promise<User[]>
}
