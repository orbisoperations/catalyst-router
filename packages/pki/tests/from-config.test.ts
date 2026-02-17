import { describe, it, expect } from 'bun:test'
import { CertificateManager } from '../src/certificate-manager.js'
import {
  PkiConfigSchema,
  PkiProviderConfigSchema,
  LocalPkiConfigSchema,
  GCloudKmsPkiConfigSchema,
  AwsKmsPkiConfigSchema,
} from '@catalyst/config'

describe('CertificateManager.fromConfig()', () => {
  describe('local provider', () => {
    it('should create a manager with persistent SQLite store', () => {
      const config = PkiConfigSchema.parse({
        provider: { type: 'local', persistent: true, certsDb: ':memory:' },
        trustDomain: 'test.example.com',
        svidTtlSeconds: 1800,
      })

      const manager = CertificateManager.fromConfig(config)
      expect(manager).toBeInstanceOf(CertificateManager)
      expect(manager.getTrustDomain()).toBe('test.example.com')
    })

    it('should create a manager with in-memory store when persistent is false', () => {
      const config = PkiConfigSchema.parse({
        provider: { type: 'local', persistent: false },
        trustDomain: 'ephemeral.example.com',
      })

      const manager = CertificateManager.fromConfig(config)
      expect(manager).toBeInstanceOf(CertificateManager)
      expect(manager.getTrustDomain()).toBe('ephemeral.example.com')
    })

    it('should default provider to local when omitted', () => {
      const config = PkiConfigSchema.parse({
        trustDomain: 'default.example.com',
      })

      expect(config.provider.type).toBe('local')
      const manager = CertificateManager.fromConfig(config)
      expect(manager).toBeInstanceOf(CertificateManager)
      expect(manager.getTrustDomain()).toBe('default.example.com')
    })

    it('should use schema defaults for all optional fields', () => {
      const config = PkiConfigSchema.parse({})

      expect(config.provider.type).toBe('local')
      expect(config.trustDomain).toBe('catalyst.example.com')
      expect(config.svidTtlSeconds).toBe(3600)
      expect(config.maxSvidTtlSeconds).toBe(86400)
      expect(config.autoRenew).toBe(true)

      const manager = CertificateManager.fromConfig(config)
      expect(manager).toBeInstanceOf(CertificateManager)
      expect(manager.getTrustDomain()).toBe('catalyst.example.com')
    })

    it('should initialize and produce a working CA hierarchy', async () => {
      const config = PkiConfigSchema.parse({
        provider: { type: 'local', persistent: false },
        trustDomain: 'init.example.com',
      })

      const manager = CertificateManager.fromConfig(config)
      const result = await manager.initialize()

      expect(result.rootFingerprint).toBeString()
      expect(result.servicesCaFingerprint).toBeString()
      expect(result.transportCaFingerprint).toBeString()
      expect(manager.isInitialized()).toBe(true)
    })

    it('should pass maxSvidTtlSeconds through to the manager', async () => {
      const config = PkiConfigSchema.parse({
        provider: { type: 'local', persistent: false },
        trustDomain: 'ttl.example.com',
        maxSvidTtlSeconds: 1800,
      })

      const manager = CertificateManager.fromConfig(config)
      expect(manager).toBeInstanceOf(CertificateManager)
    })
  })

  describe('KMS providers (Phase 2 stubs)', () => {
    it('should throw for gcloud-kms provider', () => {
      const config = PkiConfigSchema.parse({
        provider: {
          type: 'gcloud-kms',
          projectId: 'my-project',
          locationId: 'us-east1',
          keyRingId: 'my-ring',
          rootKeyId: 'root-key',
          servicesCaKeyId: 'services-key',
          transportCaKeyId: 'transport-key',
        },
      })

      expect(() => CertificateManager.fromConfig(config)).toThrow(
        "PKI provider 'gcloud-kms' is not yet implemented"
      )
    })

    it('should throw for aws-kms provider', () => {
      const config = PkiConfigSchema.parse({
        provider: {
          type: 'aws-kms',
          region: 'us-east-1',
          rootKeyArn: 'arn:aws:kms:us-east-1:123456:key/root',
          servicesCaKeyArn: 'arn:aws:kms:us-east-1:123456:key/services',
          transportCaKeyArn: 'arn:aws:kms:us-east-1:123456:key/transport',
        },
      })

      expect(() => CertificateManager.fromConfig(config)).toThrow(
        "PKI provider 'aws-kms' is not yet implemented"
      )
    })
  })

  describe('PkiConfigSchema validation', () => {
    it('should reject unknown provider type', () => {
      const result = PkiProviderConfigSchema.safeParse({
        type: 'vault',
      })
      expect(result.success).toBe(false)
    })

    it('should reject gcloud-kms without required fields', () => {
      const result = PkiProviderConfigSchema.safeParse({
        type: 'gcloud-kms',
      })
      expect(result.success).toBe(false)
    })

    it('should reject aws-kms without required fields', () => {
      const result = PkiProviderConfigSchema.safeParse({
        type: 'aws-kms',
      })
      expect(result.success).toBe(false)
    })

    it('should enforce svidTtlSeconds range', () => {
      const tooLow = PkiConfigSchema.safeParse({
        svidTtlSeconds: 10,
      })
      expect(tooLow.success).toBe(false)

      const tooHigh = PkiConfigSchema.safeParse({
        svidTtlSeconds: 100000,
      })
      expect(tooHigh.success).toBe(false)
    })

    it('should enforce maxSvidTtlSeconds range', () => {
      const tooLow = PkiConfigSchema.safeParse({
        maxSvidTtlSeconds: 10,
      })
      expect(tooLow.success).toBe(false)

      const tooHigh = PkiConfigSchema.safeParse({
        maxSvidTtlSeconds: 100000,
      })
      expect(tooHigh.success).toBe(false)
    })

    it('should accept valid local provider config', () => {
      const result = LocalPkiConfigSchema.safeParse({
        type: 'local',
        persistent: false,
        certsDb: 'custom.db',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.type).toBe('local')
        expect(result.data.persistent).toBe(false)
        expect(result.data.certsDb).toBe('custom.db')
      }
    })

    it('should default gcloud-kms locationId to global', () => {
      const result = GCloudKmsPkiConfigSchema.safeParse({
        type: 'gcloud-kms',
        projectId: 'p',
        keyRingId: 'kr',
        rootKeyId: 'rk',
        servicesCaKeyId: 'sk',
        transportCaKeyId: 'tk',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.locationId).toBe('global')
      }
    })

    it('should accept valid aws-kms provider config', () => {
      const result = AwsKmsPkiConfigSchema.safeParse({
        type: 'aws-kms',
        region: 'us-west-2',
        rootKeyArn: 'arn:aws:kms:us-west-2:111:key/root',
        servicesCaKeyArn: 'arn:aws:kms:us-west-2:111:key/svc',
        transportCaKeyArn: 'arn:aws:kms:us-west-2:111:key/tpt',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.type).toBe('aws-kms')
        expect(result.data.region).toBe('us-west-2')
      }
    })
  })
})
