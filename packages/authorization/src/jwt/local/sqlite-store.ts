import Database from 'better-sqlite3'
import type { TokenStore, TokenRecord, EntityType } from '../index.js'

interface TokenRow {
  jti: string
  expires_at: number
  certificate_fingerprint: string | null
  subject_alternative_names: string
  entity_id: string
  entity_name: string
  entity_type: string
  is_revoked: number
}

export class SqliteTokenStore implements TokenStore {
  private db: Database.Database

  constructor(path: string = ':memory:') {
    this.db = new Database(path)
    this.initialize()
  }

  private initialize() {
    this.db
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS token (
        jti TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        certificate_fingerprint TEXT,
        subject_alternative_names TEXT NOT NULL, -- JSON array
        entity_id TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        is_revoked INTEGER NOT NULL DEFAULT 0 -- 0=false, 1=true
      )
    `
      )
      .run()
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_token_expires_at ON token(expires_at)`).run()
    this.db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_token_certificate_fingerprint ON token(certificate_fingerprint)`
      )
      .run()
  }

  async recordToken(record: TokenRecord): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO token (jti, expires_at, certificate_fingerprint, subject_alternative_names, entity_id, entity_name, entity_type, is_revoked)
      VALUES ($jti, $expires_at, $certificate_fingerprint, $subject_alternative_names, $entity_id, $entity_name, $entity_type, $is_revoked)
    `)
    stmt.run({
      jti: record.jti,
      expires_at: record.expiry,
      certificate_fingerprint: record.cfn ?? null,
      subject_alternative_names: JSON.stringify(record.sans),
      entity_id: record.entityId,
      entity_name: record.entityName,
      entity_type: record.entityType,
      is_revoked: record.revoked ? 1 : 0,
    })
  }

  async findToken(jti: string): Promise<TokenRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM token WHERE jti = $jti')
    const result = stmt.get({ jti }) as TokenRow | null
    if (!result) return null

    return {
      jti: result.jti,
      expiry: result.expires_at,
      cfn: result.certificate_fingerprint || undefined,
      sans: JSON.parse(result.subject_alternative_names),
      entityId: result.entity_id,
      entityName: result.entity_name,
      entityType: result.entity_type as EntityType,
      revoked: result.is_revoked === 1,
    }
  }

  async revokeToken(jti: string): Promise<void> {
    this.db.prepare('UPDATE token SET is_revoked = 1 WHERE jti = ?').run(jti)
  }

  async revokeBySan(san: string): Promise<void> {
    // Simple LIKE search for JSON array string
    this.db
      .prepare('UPDATE token SET is_revoked = 1 WHERE subject_alternative_names LIKE ?')
      .run(`%${san}%`)
  }

  /**
   * Check if a token is revoked.
   *
   * Performance: Optimized for high-throughput (1000s req/sec).
   * - Uses PRIMARY KEY lookup on jti (O(log n))
   * - Selects only is_revoked field, not all columns
   * - Single round-trip to SQLite
   */
  async isRevoked(jti: string): Promise<boolean> {
    const stmt = this.db.prepare('SELECT is_revoked FROM token WHERE jti = $jti')
    const row = stmt.get({ jti }) as { is_revoked: number } | null
    return row ? row.is_revoked === 1 : false
  }

  async getRevocationList(): Promise<string[]> {
    const now = Math.floor(Date.now() / 1000)
    const rows = this.db
      .prepare('SELECT jti FROM token WHERE is_revoked = 1 AND expires_at > ?')
      .all(now) as { jti: string }[]
    return rows.map((r) => r.jti)
  }

  async listTokens(filter?: {
    certificateFingerprint?: string
    san?: string
  }): Promise<TokenRecord[]> {
    let query = 'SELECT * FROM token WHERE 1=1'
    const params: Record<string, string | number | null> = {}

    if (filter?.certificateFingerprint) {
      query += ' AND certificate_fingerprint = $cfn'
      params.cfn = filter.certificateFingerprint
    }

    if (filter?.san) {
      query += ' AND subject_alternative_names LIKE $san'
      params.san = `%${filter.san}%`
    }

    const stmt = this.db.prepare(query)
    const rows = stmt.all(params) as TokenRow[]
    return rows.map((row) => ({
      jti: row.jti,
      expiry: row.expires_at,
      cfn: row.certificate_fingerprint || undefined,
      sans: JSON.parse(row.subject_alternative_names),
      entityId: row.entity_id,
      entityName: row.entity_name,
      entityType: row.entity_type as EntityType,
      revoked: row.is_revoked === 1,
    }))
  }
}
