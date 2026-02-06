import { Database } from 'bun:sqlite'
import type { JSONWebKeySet } from 'jose'
import type { IKeyStore } from './index.js'

export class BunSqliteKeyStore implements IKeyStore {
    private db: Database

    constructor(path: string = ':memory:') {
        this.db = new Database(path)
        this.initialize()
    }

    private initialize() {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS key_store (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                jwks TEXT NOT NULL
            )
        `)
    }

    async saveKeys(jwks: JSONWebKeySet): Promise<void> {
        this.db.run(
            'INSERT OR REPLACE INTO key_store (id, jwks) VALUES (1, ?)',
            [JSON.stringify(jwks)]
        )
    }

    async loadKeys(): Promise<JSONWebKeySet | null> {
        const row = this.db.query('SELECT jwks FROM key_store WHERE id = 1').get() as { jwks: string } | null
        if (!row) return null
        return JSON.parse(row.jwks)
    }
}
