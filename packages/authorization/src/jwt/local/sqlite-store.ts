import { Database } from 'bun:sqlite'
import type { TokenStore, TokenRecord, EntityType } from '../index.js'

interface TokenRow {
  jti: string
  expiry: number
  cfn: string | null
  sans: string
  entity_id: string
  entity_name: string
  entity_type: string
  revoked: number
}

export class BunSqliteTokenStore implements TokenStore {
  private db: Database

  constructor(path: string = ':memory:') {
    this.db = new Database(path)
    this.initialize()
  }

  private initialize() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tokens (
        jti TEXT PRIMARY KEY,
        expiry INTEGER NOT NULL,
        cfn TEXT,
        sans TEXT NOT NULL, -- JSON array
        entity_id TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0 -- 0=false, 1=true
      )
    `)
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tokens_expiry ON tokens(expiry)`)
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tokens_cfn ON tokens(cfn)`)
  }

  async recordToken(record: TokenRecord): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO tokens (jti, expiry, cfn, sans, entity_id, entity_name, entity_type, revoked)
      VALUES ($jti, $expiry, $cfn, $sans, $entityId, $entityName, $entityType, $revoked)
    `)
    stmt.run({
      $jti: record.jti,
      $expiry: record.expiry,
      $cfn: record.cfn ?? null,
      $sans: JSON.stringify(record.sans),
      $entityId: record.entityId,
      $entityName: record.entityName,
      $entityType: record.entityType,
      $revoked: record.revoked ? 1 : 0,
    })
  }

  async findToken(jti: string): Promise<TokenRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM tokens WHERE jti = $jti')
    const result = stmt.get({ $jti: jti }) as TokenRow | null
    if (!result) return null

    return {
      jti: result.jti,
      expiry: result.expiry,
      cfn: result.cfn || undefined,
      sans: JSON.parse(result.sans),
      entityId: result.entity_id,
      entityName: result.entity_name,
      entityType: result.entity_type as EntityType,
      revoked: result.revoked === 1,
    }
  }

  async revokeToken(jti: string): Promise<void> {
    this.db.run('UPDATE tokens SET revoked = 1 WHERE jti = ?', [jti])
  }

  async revokeBySan(san: string): Promise<void> {
    // Simple LIKE search for JSON array string
    this.db.run('UPDATE tokens SET revoked = 1 WHERE sans LIKE ?', [`%${san}%`])
  }

  async isRevoked(jti: string): Promise<boolean> {
    const stmt = this.db.prepare('SELECT revoked FROM tokens WHERE jti = $jti')
    const row = stmt.get({ $jti: jti }) as { revoked: number } | null
    return row ? row.revoked === 1 : false
  }

  async getRevocationList(): Promise<string[]> {
    const now = Math.floor(Date.now() / 1000)
    const rows = this.db
      .query('SELECT jti FROM tokens WHERE revoked = 1 AND expiry > ?')
      .all(now) as { jti: string }[]
    return rows.map((r) => r.jti)
  }

  async listTokens(filter?: {
    certificateFingerprint?: string
    san?: string
  }): Promise<TokenRecord[]> {
    let query = 'SELECT * FROM tokens WHERE 1=1'
    const params: Record<string, string | number | null> = {}

    if (filter?.certificateFingerprint) {
      query += ' AND cfn = $cfn'
      params.$cfn = filter.certificateFingerprint
    }

    if (filter?.san) {
      query += ' AND sans LIKE $san'
      params.$san = `%${filter.san}%`
    }

    const stmt = this.db.prepare(query)
    const rows = stmt.all(params) as TokenRow[]
    return rows.map((row) => ({
      jti: row.jti,
      expiry: row.expiry,
      cfn: row.cfn || undefined,
      sans: JSON.parse(row.sans),
      entityId: row.entity_id,
      entityName: row.entity_name,
      entityType: row.entity_type as EntityType,
      revoked: row.revoked === 1,
    }))
  }
}
