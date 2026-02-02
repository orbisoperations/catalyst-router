import { Database } from 'bun:sqlite'
import type { TokenStore, TokenRecord, EntityType } from '../index.js'

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
        entity_id TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        entity_type TEXT NOT NULL
      )
    `)
    }

    async recordToken(record: TokenRecord): Promise<void> {
        const stmt = this.db.prepare(`
      INSERT INTO tokens (jti, expiry, cfn, entity_id, entity_name, entity_type)
      VALUES ($jti, $expiry, $cfn, $entityId, $entityName, $entityType)
    `)
        stmt.run({
            $jti: record.jti,
            $expiry: record.expiry,
            $cfn: record.cfn ?? null,
            $entityId: record.entityId,
            $entityName: record.entityName,
            $entityType: record.entityType,
        })
    }

    async findToken(jti: string): Promise<TokenRecord | null> {
        const stmt = this.db.prepare('SELECT * FROM tokens WHERE jti = $jti')
        const result = stmt.get({ $jti: jti }) as any
        if (!result) return null

        return {
            jti: result.jti,
            expiry: result.expiry,
            cfn: result.cfn || undefined,
            entityId: result.entity_id,
            entityName: result.entity_name,
            entityType: result.entity_type as EntityType,
        }
    }

    async isRevoked(jti: string): Promise<boolean> {
        // Basic implementation: if it's not in our DB, it might be revoked or just tracked elsewhere.
        // In a more robust implementation, we might have a specific revocation table.
        // For now, we'll just check if it exists and hasn't expired.
        const token = await this.findToken(jti)
        if (!token) return true // Treat unknown tokens as revoked for safety

        const now = Math.floor(Date.now() / 1000)
        return token.expiry < now
    }
}
