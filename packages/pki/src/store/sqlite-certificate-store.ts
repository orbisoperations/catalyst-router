import { Database } from 'bun:sqlite'
import type {
  ICertificateStore,
  CertificateRecord,
  CertificateType,
  CertificateStatus,
  DenyListEntry,
} from '../types.js'

interface CertificateRow {
  serial: string
  fingerprint: string
  type: string
  common_name: string
  spiffe_id: string | null
  certificate_pem: string
  private_key_pem: string | null
  issuer_serial: string | null
  not_before: number
  not_after: number
  status: string
  created_at: number
}

interface DenyListRow {
  spiffe_id: string
  reason: string
  denied_at: number
}

interface CountRow {
  type: string
  status: string
  count: number
}

function rowToRecord(row: CertificateRow): CertificateRecord {
  return {
    serial: row.serial,
    fingerprint: row.fingerprint,
    type: row.type as CertificateType,
    commonName: row.common_name,
    spiffeId: row.spiffe_id,
    certificatePem: row.certificate_pem,
    privateKeyPem: row.private_key_pem,
    issuerSerial: row.issuer_serial,
    notBefore: row.not_before,
    notAfter: row.not_after,
    status: row.status as CertificateStatus,
    createdAt: row.created_at,
  }
}

export class BunSqliteCertificateStore implements ICertificateStore {
  private db: Database

  constructor(path: string = ':memory:') {
    this.db = new Database(path)
    this.createSchema()
  }

  private createSchema(): void {
    this.db.run('BEGIN')
    try {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS certificate (
          serial TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          common_name TEXT NOT NULL,
          spiffe_id TEXT,
          certificate_pem TEXT NOT NULL,
          private_key_pem TEXT,
          issuer_serial TEXT,
          not_before INTEGER NOT NULL,
          not_after INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL
        )
      `)

      this.db.run(`CREATE INDEX IF NOT EXISTS idx_cert_type_status ON certificate(type, status)`)
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_cert_fingerprint ON certificate(fingerprint)`)
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_cert_spiffe_id ON certificate(spiffe_id)`)
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_cert_not_after ON certificate(not_after)`)

      this.db.run(`
        CREATE TABLE IF NOT EXISTS denied_identity (
          spiffe_id TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          denied_at INTEGER NOT NULL
        )
      `)

      this.db.run('COMMIT')
    } catch (err) {
      this.db.run('ROLLBACK')
      throw err
    }
  }

  // --- CA certificates ---

  async saveCaCertificate(record: CertificateRecord): Promise<void> {
    this.db.run('BEGIN')
    try {
      // Supersede any existing active CA of the same type
      this.db.run(
        `UPDATE certificate SET status = 'superseded' WHERE type = $type AND status = 'active'`,
        { $type: record.type }
      )

      this.db.run(
        `INSERT OR REPLACE INTO certificate
          (serial, fingerprint, type, common_name, spiffe_id, certificate_pem, private_key_pem,
           issuer_serial, not_before, not_after, status, created_at)
         VALUES ($serial, $fingerprint, $type, $common_name, $spiffe_id, $certificate_pem,
                 $private_key_pem, $issuer_serial, $not_before, $not_after, $status, $created_at)`,
        {
          $serial: record.serial,
          $fingerprint: record.fingerprint,
          $type: record.type,
          $common_name: record.commonName,
          $spiffe_id: record.spiffeId,
          $certificate_pem: record.certificatePem,
          $private_key_pem: record.privateKeyPem,
          $issuer_serial: record.issuerSerial,
          $not_before: record.notBefore,
          $not_after: record.notAfter,
          $status: record.status,
          $created_at: record.createdAt,
        }
      )

      this.db.run('COMMIT')
    } catch (err) {
      this.db.run('ROLLBACK')
      throw err
    }
  }

  async loadCaCertificate(
    type: 'root-ca' | 'services-ca' | 'transport-ca'
  ): Promise<CertificateRecord | null> {
    const row = this.db
      .query(`SELECT * FROM certificate WHERE type = $type AND status = 'active' LIMIT 1`)
      .get({ $type: type }) as CertificateRow | null
    if (!row) return null
    return rowToRecord(row)
  }

  async loadAllCaCertificates(
    type: 'root-ca' | 'services-ca' | 'transport-ca'
  ): Promise<CertificateRecord[]> {
    const rows = this.db
      .query(
        `SELECT * FROM certificate WHERE type = $type AND status IN ('active', 'superseded') ORDER BY created_at DESC`
      )
      .all({ $type: type }) as CertificateRow[]
    return rows.map(rowToRecord)
  }

  // --- End-entity certificates ---

  async saveEndEntityCertificate(record: CertificateRecord): Promise<void> {
    this.db.run(
      `INSERT INTO certificate
        (serial, fingerprint, type, common_name, spiffe_id, certificate_pem, private_key_pem,
         issuer_serial, not_before, not_after, status, created_at)
       VALUES ($serial, $fingerprint, $type, $common_name, $spiffe_id, $certificate_pem,
               $private_key_pem, $issuer_serial, $not_before, $not_after, $status, $created_at)`,
      {
        $serial: record.serial,
        $fingerprint: record.fingerprint,
        $type: record.type,
        $common_name: record.commonName,
        $spiffe_id: record.spiffeId,
        $certificate_pem: record.certificatePem,
        $private_key_pem: record.privateKeyPem,
        $issuer_serial: record.issuerSerial,
        $not_before: record.notBefore,
        $not_after: record.notAfter,
        $status: record.status,
        $created_at: record.createdAt,
      }
    )
  }

  async findBySerial(serial: string): Promise<CertificateRecord | null> {
    const row = this.db
      .query(`SELECT * FROM certificate WHERE serial = $serial`)
      .get({ $serial: serial }) as CertificateRow | null
    if (!row) return null
    return rowToRecord(row)
  }

  async findByFingerprint(fingerprint: string): Promise<CertificateRecord | null> {
    const row = this.db
      .query(`SELECT * FROM certificate WHERE fingerprint = $fingerprint`)
      .get({ $fingerprint: fingerprint }) as CertificateRow | null
    if (!row) return null
    return rowToRecord(row)
  }

  async findBySpiffeId(spiffeId: string): Promise<CertificateRecord[]> {
    const now = Date.now()
    const rows = this.db
      .query(
        `SELECT * FROM certificate WHERE spiffe_id = $spiffe_id AND status = 'active' AND not_after > $now`
      )
      .all({ $spiffe_id: spiffeId, $now: now }) as CertificateRow[]
    return rows.map(rowToRecord)
  }

  async listActiveCertificates(): Promise<CertificateRecord[]> {
    const now = Date.now()
    const rows = this.db
      .query(
        `SELECT * FROM certificate WHERE type = 'end-entity' AND status = 'active' AND not_after > $now`
      )
      .all({ $now: now }) as CertificateRow[]
    return rows.map(rowToRecord)
  }

  async markSuperseded(serial: string): Promise<void> {
    this.db.run(`UPDATE certificate SET status = 'superseded' WHERE serial = $serial`, {
      $serial: serial,
    })
  }

  // --- Deny list ---

  async denyIdentity(spiffeId: string, reason: string): Promise<void> {
    this.db.run(
      `INSERT OR REPLACE INTO denied_identity (spiffe_id, reason, denied_at) VALUES ($spiffe_id, $reason, $denied_at)`,
      {
        $spiffe_id: spiffeId,
        $reason: reason,
        $denied_at: Date.now(),
      }
    )
  }

  async allowIdentity(spiffeId: string): Promise<void> {
    this.db.run(`DELETE FROM denied_identity WHERE spiffe_id = $spiffe_id`, {
      $spiffe_id: spiffeId,
    })
  }

  async isDenied(spiffeId: string): Promise<boolean> {
    const row = this.db
      .query(`SELECT 1 FROM denied_identity WHERE spiffe_id = $spiffe_id LIMIT 1`)
      .get({ $spiffe_id: spiffeId })
    return row !== null
  }

  async listDeniedIdentities(): Promise<DenyListEntry[]> {
    const rows = this.db
      .query(`SELECT * FROM denied_identity ORDER BY denied_at DESC`)
      .all() as DenyListRow[]
    return rows.map((row) => ({
      spiffeId: row.spiffe_id,
      reason: row.reason,
      deniedAt: row.denied_at,
    }))
  }

  // --- Maintenance ---

  async purgeExpired(cutoffMs: number): Promise<number> {
    // Count before delete so we can return the number purged
    const countRow = this.db
      .query(
        `SELECT COUNT(*) as count FROM certificate WHERE not_after < $cutoff AND type = 'end-entity'`
      )
      .get({ $cutoff: cutoffMs }) as { count: number }
    const count = countRow.count

    if (count > 0) {
      this.db.run(`DELETE FROM certificate WHERE not_after < $cutoff AND type = 'end-entity'`, {
        $cutoff: cutoffMs,
      })
    }

    return count
  }

  async countCertificates(): Promise<
    { type: CertificateType; status: CertificateStatus; count: number }[]
  > {
    const rows = this.db
      .query(`SELECT type, status, COUNT(*) as count FROM certificate GROUP BY type, status`)
      .all() as CountRow[]
    return rows.map((row) => ({
      type: row.type as CertificateType,
      status: row.status as CertificateStatus,
      count: row.count,
    }))
  }
}
