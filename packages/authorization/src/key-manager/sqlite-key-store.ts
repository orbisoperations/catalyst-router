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
            CREATE TABLE IF NOT EXISTS key_set (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                json_web_key_set TEXT NOT NULL
            )
        `)
  }

  async saveKeys(jwks: JSONWebKeySet): Promise<void> {
    this.db.run('INSERT OR REPLACE INTO key_set (id, json_web_key_set) VALUES (1, ?)', [
      JSON.stringify(jwks),
    ])
  }

  async loadKeys(): Promise<JSONWebKeySet | null> {
    const row = this.db.query('SELECT json_web_key_set FROM key_set WHERE id = 1').get() as {
      json_web_key_set: string
    } | null
    if (!row) return null
    return JSON.parse(row.json_web_key_set)
  }
}
