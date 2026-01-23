import { describe, it, expect, beforeEach } from 'bun:test'
import { generateApiKey, extractPrefix, encodeBase62 } from '../src/api-key.js'
import { ApiKeyService } from '../src/api-key-service.js'
import { InMemoryServiceAccountStore } from '../src/stores/memory.js'

describe('API Key utilities', () => {
  describe('encodeBase62', () => {
    it('should encode bytes to base62 string', () => {
      const bytes = new Uint8Array([0, 1, 2, 3, 255])
      const encoded = encodeBase62(bytes)

      expect(encoded).toMatch(/^[0-9A-Za-z]+$/)
      expect(encoded.length).toBeGreaterThan(0)
    })
  })

  describe('generateApiKey', () => {
    it('should generate key with correct prefix format', () => {
      const { key, prefix, secret } = generateApiKey('dflt')

      expect(prefix).toBe('cat_sk_dflt_')
      expect(key).toStartWith('cat_sk_dflt_')
      expect(secret.length).toBeGreaterThan(20)
    })

    it('should generate unique keys', () => {
      const key1 = generateApiKey('dflt')
      const key2 = generateApiKey('dflt')

      expect(key1.key).not.toBe(key2.key)
      expect(key1.secret).not.toBe(key2.secret)
    })

    it('should use org identifier in prefix', () => {
      const { prefix, key } = generateApiKey('myorg')

      expect(prefix).toBe('cat_sk_myorg_')
      expect(key).toStartWith('cat_sk_myorg_')
    })
  })

  describe('extractPrefix', () => {
    it('should extract prefix from valid key', () => {
      const prefix = extractPrefix('cat_sk_dflt_abc123xyz')
      expect(prefix).toBe('cat_sk_dflt_')
    })

    it('should return null for invalid key format', () => {
      expect(extractPrefix('invalid_key')).toBeNull()
      expect(extractPrefix('cat_sk_')).toBeNull()
      expect(extractPrefix('')).toBeNull()
    })
  })
})

describe('ApiKeyService', () => {
  let saStore: InMemoryServiceAccountStore
  let service: ApiKeyService

  beforeEach(() => {
    saStore = new InMemoryServiceAccountStore()
    service = new ApiKeyService(saStore)
  })

  describe('createServiceAccount', () => {
    it('should create SA and return plaintext key', async () => {
      const result = await service.createServiceAccount({
        name: 'ci-bot',
        roles: ['operator'],
        orgId: 'default',
        expiresInDays: 30,
        createdBy: 'usr_admin123',
      })

      expect(result.success).toBe(true)
      expect(result.serviceAccountId).toMatch(/^sa_/)
      expect(result.apiKey).toStartWith('cat_sk_dflt_')
      expect(result.expiresAt).toBeInstanceOf(Date)
    })

    it('should reject duplicate name in same org', async () => {
      await service.createServiceAccount({
        name: 'ci-bot',
        roles: ['operator'],
        orgId: 'default',
        expiresInDays: 30,
        createdBy: 'usr_admin123',
      })

      const result = await service.createServiceAccount({
        name: 'ci-bot',
        roles: ['operator'],
        orgId: 'default',
        expiresInDays: 30,
        createdBy: 'usr_admin123',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Service account with this name already exists')
    })

    it('should reject expiry over 1 year', async () => {
      const result = await service.createServiceAccount({
        name: 'ci-bot',
        roles: ['operator'],
        orgId: 'default',
        expiresInDays: 400,
        createdBy: 'usr_admin123',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Expiry cannot exceed 1 year')
    })
  })

  describe('authenticateApiKey', () => {
    it('should authenticate valid key', async () => {
      const createResult = await service.createServiceAccount({
        name: 'ci-bot',
        roles: ['operator'],
        orgId: 'default',
        expiresInDays: 30,
        createdBy: 'usr_admin123',
      })

      const result = await service.authenticateApiKey(createResult.apiKey!)

      expect(result.success).toBe(true)
      expect(result.auth?.userId).toBe(createResult.serviceAccountId)
      expect(result.auth?.roles).toEqual(['operator'])
      expect(result.auth?.orgId).toBe('default')
    })

    it('should reject invalid key (timing-safe)', async () => {
      await service.createServiceAccount({
        name: 'ci-bot',
        roles: ['operator'],
        orgId: 'default',
        expiresInDays: 30,
        createdBy: 'usr_admin123',
      })

      const result = await service.authenticateApiKey('cat_sk_dflt_wrongkey')

      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid API key')
    })

    it('should reject unknown prefix', async () => {
      const result = await service.authenticateApiKey('cat_sk_unknown_abc123')

      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid API key')
    })

    it('should reject expired key', async () => {
      const createResult = await service.createServiceAccount({
        name: 'ci-bot',
        roles: ['operator'],
        orgId: 'default',
        expiresInDays: 0,
        createdBy: 'usr_admin123',
      })

      await new Promise((resolve) => setTimeout(resolve, 10))

      const result = await service.authenticateApiKey(createResult.apiKey!)

      expect(result.success).toBe(false)
      expect(result.error).toBe('API key expired')
    })

    it('should reject malformed key', async () => {
      const result = await service.authenticateApiKey('not_a_valid_key')

      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid API key')
    })
  })

  describe('listServiceAccounts', () => {
    it('should list SAs for org without exposing hash', async () => {
      await service.createServiceAccount({
        name: 'bot1',
        roles: ['operator'],
        orgId: 'default',
        expiresInDays: 30,
        createdBy: 'usr_admin',
      })
      await service.createServiceAccount({
        name: 'bot2',
        roles: ['viewer'],
        orgId: 'default',
        expiresInDays: 30,
        createdBy: 'usr_admin',
      })

      const accounts = await service.listServiceAccounts('default')

      expect(accounts).toHaveLength(2)
      expect(accounts.map((a) => a.name).sort()).toEqual(['bot1', 'bot2'])
    })
  })

  describe('deleteServiceAccount', () => {
    it('should delete SA by id', async () => {
      const { serviceAccountId } = await service.createServiceAccount({
        name: 'ci-bot',
        roles: ['operator'],
        orgId: 'default',
        expiresInDays: 30,
        createdBy: 'usr_admin',
      })

      await service.deleteServiceAccount(serviceAccountId!)

      const accounts = await service.listServiceAccounts('default')
      expect(accounts).toHaveLength(0)
    })
  })
})
