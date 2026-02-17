import { describe, it, expect, beforeEach } from 'bun:test'
import { BunSqliteCertificateStore } from '../../src/store/sqlite-certificate-store.js'
import type { CertificateRecord } from '../../src/types.js'

/** Helper to create a CertificateRecord with sensible defaults */
function makeCert(overrides: Partial<CertificateRecord> = {}): CertificateRecord {
  const now = Date.now()
  return {
    serial: 'serial-001',
    fingerprint: 'fp-001',
    type: 'end-entity',
    commonName: 'test-service',
    spiffeId: 'spiffe://example.com/node/test-1',
    certificatePem: '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----',
    privateKeyPem: null,
    issuerSerial: 'issuer-001',
    notBefore: now - 60_000,
    notAfter: now + 3_600_000, // 1 hour from now
    status: 'active',
    createdAt: now,
    ...overrides,
  }
}

describe('BunSqliteCertificateStore', () => {
  let store: BunSqliteCertificateStore

  beforeEach(() => {
    store = new BunSqliteCertificateStore(':memory:')
  })

  // --- CA certificates ---

  describe('CA certificates', () => {
    it('should round-trip saveCaCertificate + loadCaCertificate', async () => {
      const rootCa = makeCert({
        serial: 'root-001',
        fingerprint: 'root-fp-001',
        type: 'root-ca',
        commonName: 'Catalyst Root CA',
        spiffeId: null,
        issuerSerial: null,
      })

      await store.saveCaCertificate(rootCa)
      const loaded = await store.loadCaCertificate('root-ca')

      expect(loaded).not.toBeNull()
      expect(loaded!.serial).toBe('root-001')
      expect(loaded!.fingerprint).toBe('root-fp-001')
      expect(loaded!.type).toBe('root-ca')
      expect(loaded!.commonName).toBe('Catalyst Root CA')
      expect(loaded!.spiffeId).toBeNull()
      expect(loaded!.issuerSerial).toBeNull()
      expect(loaded!.status).toBe('active')
    })

    it('should return null when no CA exists', async () => {
      const result = await store.loadCaCertificate('root-ca')
      expect(result).toBeNull()
    })

    it('should supersede previous active CA of same type', async () => {
      const ca1 = makeCert({
        serial: 'root-001',
        fingerprint: 'root-fp-001',
        type: 'root-ca',
        commonName: 'Root CA v1',
        spiffeId: null,
        issuerSerial: null,
        status: 'active',
      })
      const ca2 = makeCert({
        serial: 'root-002',
        fingerprint: 'root-fp-002',
        type: 'root-ca',
        commonName: 'Root CA v2',
        spiffeId: null,
        issuerSerial: null,
        status: 'active',
      })

      await store.saveCaCertificate(ca1)
      await store.saveCaCertificate(ca2)

      // The active CA should be the new one
      const active = await store.loadCaCertificate('root-ca')
      expect(active!.serial).toBe('root-002')

      // The old one should be superseded
      const old = await store.findBySerial('root-001')
      expect(old!.status).toBe('superseded')
    })

    it('should not supersede CAs of different types', async () => {
      const rootCa = makeCert({
        serial: 'root-001',
        fingerprint: 'root-fp-001',
        type: 'root-ca',
        spiffeId: null,
        issuerSerial: null,
      })
      const servicesCa = makeCert({
        serial: 'svc-001',
        fingerprint: 'svc-fp-001',
        type: 'services-ca',
        spiffeId: null,
        issuerSerial: 'root-001',
      })

      await store.saveCaCertificate(rootCa)
      await store.saveCaCertificate(servicesCa)

      // Both should still be active
      const root = await store.loadCaCertificate('root-ca')
      const svc = await store.loadCaCertificate('services-ca')
      expect(root!.status).toBe('active')
      expect(svc!.status).toBe('active')
    })

    it('should return both active and superseded in loadAllCaCertificates', async () => {
      const ca1 = makeCert({
        serial: 'root-001',
        fingerprint: 'root-fp-001',
        type: 'root-ca',
        spiffeId: null,
        issuerSerial: null,
        createdAt: Date.now() - 1000,
      })
      const ca2 = makeCert({
        serial: 'root-002',
        fingerprint: 'root-fp-002',
        type: 'root-ca',
        spiffeId: null,
        issuerSerial: null,
        createdAt: Date.now(),
      })

      await store.saveCaCertificate(ca1)
      await store.saveCaCertificate(ca2)

      const all = await store.loadAllCaCertificates('root-ca')
      expect(all).toHaveLength(2)
      // Ordered by created_at DESC — newest first
      expect(all[0].serial).toBe('root-002')
      expect(all[0].status).toBe('active')
      expect(all[1].serial).toBe('root-001')
      expect(all[1].status).toBe('superseded')
    })
  })

  // --- End-entity certificates ---

  describe('end-entity certificates', () => {
    it('should round-trip saveEndEntityCertificate + findBySerial', async () => {
      const cert = makeCert({ serial: 'ee-001', fingerprint: 'ee-fp-001' })
      await store.saveEndEntityCertificate(cert)

      const found = await store.findBySerial('ee-001')
      expect(found).not.toBeNull()
      expect(found!.serial).toBe('ee-001')
      expect(found!.commonName).toBe('test-service')
      expect(found!.spiffeId).toBe('spiffe://example.com/node/test-1')
    })

    it('should find by fingerprint', async () => {
      const cert = makeCert({ serial: 'ee-002', fingerprint: 'ee-fp-002' })
      await store.saveEndEntityCertificate(cert)

      const found = await store.findByFingerprint('ee-fp-002')
      expect(found).not.toBeNull()
      expect(found!.serial).toBe('ee-002')
    })

    it('should return null for non-existent serial', async () => {
      const found = await store.findBySerial('nonexistent')
      expect(found).toBeNull()
    })

    it('should return null for non-existent fingerprint', async () => {
      const found = await store.findByFingerprint('nonexistent')
      expect(found).toBeNull()
    })

    it('should find by SPIFFE ID — only active and non-expired', async () => {
      const now = Date.now()
      const spiffeId = 'spiffe://example.com/node/test-1'

      // Active, non-expired — should be found
      const active = makeCert({
        serial: 'ee-a',
        fingerprint: 'fp-a',
        spiffeId,
        status: 'active',
        notAfter: now + 3_600_000,
      })
      // Active but expired — should NOT be found
      const expired = makeCert({
        serial: 'ee-b',
        fingerprint: 'fp-b',
        spiffeId,
        status: 'active',
        notAfter: now - 1000,
      })
      // Superseded — should NOT be found
      const superseded = makeCert({
        serial: 'ee-c',
        fingerprint: 'fp-c',
        spiffeId,
        status: 'superseded',
        notAfter: now + 3_600_000,
      })

      await store.saveEndEntityCertificate(active)
      await store.saveEndEntityCertificate(expired)
      await store.saveEndEntityCertificate(superseded)

      const results = await store.findBySpiffeId(spiffeId)
      expect(results).toHaveLength(1)
      expect(results[0].serial).toBe('ee-a')
    })

    it('should list only active non-expired end-entity certs', async () => {
      const now = Date.now()

      // Active, non-expired end-entity
      await store.saveEndEntityCertificate(
        makeCert({
          serial: 'ee-1',
          fingerprint: 'fp-1',
          type: 'end-entity',
          status: 'active',
          notAfter: now + 3_600_000,
        })
      )
      // Active but expired end-entity
      await store.saveEndEntityCertificate(
        makeCert({
          serial: 'ee-2',
          fingerprint: 'fp-2',
          type: 'end-entity',
          status: 'active',
          notAfter: now - 1000,
        })
      )
      // Superseded end-entity
      await store.saveEndEntityCertificate(
        makeCert({
          serial: 'ee-3',
          fingerprint: 'fp-3',
          type: 'end-entity',
          status: 'superseded',
          notAfter: now + 3_600_000,
        })
      )
      // CA cert (should not appear)
      await store.saveCaCertificate(
        makeCert({
          serial: 'ca-1',
          fingerprint: 'ca-fp-1',
          type: 'root-ca',
          spiffeId: null,
          issuerSerial: null,
          status: 'active',
          notAfter: now + 3_600_000,
        })
      )

      const results = await store.listActiveCertificates()
      expect(results).toHaveLength(1)
      expect(results[0].serial).toBe('ee-1')
    })

    it('should mark a certificate as superseded', async () => {
      const cert = makeCert({ serial: 'ee-mark', fingerprint: 'fp-mark' })
      await store.saveEndEntityCertificate(cert)

      await store.markSuperseded('ee-mark')

      const found = await store.findBySerial('ee-mark')
      expect(found!.status).toBe('superseded')
    })
  })

  // --- Deny list ---

  describe('deny list', () => {
    it('should round-trip denyIdentity + isDenied', async () => {
      const spiffeId = 'spiffe://example.com/node/bad-node'

      expect(await store.isDenied(spiffeId)).toBe(false)

      await store.denyIdentity(spiffeId, 'compromised key')

      expect(await store.isDenied(spiffeId)).toBe(true)
    })

    it('should allow removing a denied identity', async () => {
      const spiffeId = 'spiffe://example.com/node/temp-deny'

      await store.denyIdentity(spiffeId, 'temporary')
      expect(await store.isDenied(spiffeId)).toBe(true)

      await store.allowIdentity(spiffeId)
      expect(await store.isDenied(spiffeId)).toBe(false)
    })

    it('should list all denied identities ordered by denied_at DESC', async () => {
      await store.denyIdentity('spiffe://example.com/node/a', 'reason-a')
      // Ensure different timestamps by waiting 2ms
      await new Promise((r) => setTimeout(r, 2))
      await store.denyIdentity('spiffe://example.com/node/b', 'reason-b')

      const list = await store.listDeniedIdentities()
      expect(list).toHaveLength(2)
      // Most recent first (b was denied after a)
      expect(list[0].spiffeId).toBe('spiffe://example.com/node/b')
      expect(list[0].reason).toBe('reason-b')
      expect(list[1].spiffeId).toBe('spiffe://example.com/node/a')
    })

    it('should update reason on re-deny of same identity', async () => {
      const spiffeId = 'spiffe://example.com/node/re-deny'

      await store.denyIdentity(spiffeId, 'first reason')
      await store.denyIdentity(spiffeId, 'updated reason')

      const list = await store.listDeniedIdentities()
      expect(list).toHaveLength(1)
      expect(list[0].reason).toBe('updated reason')
    })
  })

  // --- Maintenance ---

  describe('maintenance', () => {
    it('should purge expired end-entity certs and return count', async () => {
      const now = Date.now()
      const cutoff = now

      // Expired end-entity — should be purged
      await store.saveEndEntityCertificate(
        makeCert({
          serial: 'exp-1',
          fingerprint: 'fp-exp-1',
          type: 'end-entity',
          notAfter: now - 100_000,
        })
      )
      await store.saveEndEntityCertificate(
        makeCert({
          serial: 'exp-2',
          fingerprint: 'fp-exp-2',
          type: 'end-entity',
          notAfter: now - 200_000,
        })
      )
      // Not expired — should remain
      await store.saveEndEntityCertificate(
        makeCert({
          serial: 'live-1',
          fingerprint: 'fp-live-1',
          type: 'end-entity',
          notAfter: now + 3_600_000,
        })
      )

      const purged = await store.purgeExpired(cutoff)
      expect(purged).toBe(2)

      // Verify purged records are gone
      expect(await store.findBySerial('exp-1')).toBeNull()
      expect(await store.findBySerial('exp-2')).toBeNull()
      expect(await store.findBySerial('live-1')).not.toBeNull()
    })

    it('should NOT purge CA certificates', async () => {
      const now = Date.now()

      // Expired CA cert
      await store.saveCaCertificate(
        makeCert({
          serial: 'old-ca',
          fingerprint: 'fp-old-ca',
          type: 'root-ca',
          spiffeId: null,
          issuerSerial: null,
          notAfter: now - 100_000,
        })
      )

      const purged = await store.purgeExpired(now)
      expect(purged).toBe(0)

      // CA should still exist
      expect(await store.findBySerial('old-ca')).not.toBeNull()
    })

    it('should return zero when nothing to purge', async () => {
      const purged = await store.purgeExpired(Date.now())
      expect(purged).toBe(0)
    })

    it('should return grouped counts by type and status', async () => {
      await store.saveCaCertificate(
        makeCert({
          serial: 'root-1',
          fingerprint: 'fp-r1',
          type: 'root-ca',
          spiffeId: null,
          issuerSerial: null,
        })
      )
      await store.saveEndEntityCertificate(
        makeCert({ serial: 'ee-1', fingerprint: 'fp-ee1', type: 'end-entity' })
      )
      await store.saveEndEntityCertificate(
        makeCert({
          serial: 'ee-2',
          fingerprint: 'fp-ee2',
          type: 'end-entity',
          status: 'superseded',
        })
      )

      const counts = await store.countCertificates()
      expect(counts.length).toBeGreaterThanOrEqual(2)

      const rootActive = counts.find((c) => c.type === 'root-ca' && c.status === 'active')
      expect(rootActive).toBeDefined()
      expect(rootActive!.count).toBe(1)

      const eeActive = counts.find((c) => c.type === 'end-entity' && c.status === 'active')
      expect(eeActive).toBeDefined()
      expect(eeActive!.count).toBe(1)

      const eeSuperseded = counts.find((c) => c.type === 'end-entity' && c.status === 'superseded')
      expect(eeSuperseded).toBeDefined()
      expect(eeSuperseded!.count).toBe(1)
    })
  })
})
