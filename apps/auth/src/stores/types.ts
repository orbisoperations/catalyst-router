import type { User, CreateUserInput } from '../models/user.js'
import type { ServiceAccount, CreateServiceAccountInput } from '../models/service-account.js'

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

/**
 * ServiceAccountStore interface - persistence for ServiceAccount entities
 */
export interface ServiceAccountStore {
  create(sa: CreateServiceAccountInput): Promise<ServiceAccount>
  findById(id: string): Promise<ServiceAccount | null>
  findByPrefix(prefix: string): Promise<ServiceAccount | null>
  findByName(name: string, orgId?: string): Promise<ServiceAccount | null>
  delete(id: string): Promise<void>
  list(orgId?: string): Promise<ServiceAccount[]>
}
