import Database from 'better-sqlite3'
import type { JSONWebKeySet } from 'jose'
import type { IKeyStore } from './index.js'

export class SqliteKeyStore implements IKeyStore {
  private db: Database.Database

  constructor(path: string = ':memory:') {
    this.db = new Database(path)
    this.initialize()
  }

  private initialize() {
    this.db
      .prepare(
        `
            CREATE TABLE IF NOT EXISTS key_set (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                json_web_key_set TEXT NOT NULL
            )
        `
      )
      .run()
  }

  async saveKeys(jwks: JSONWebKeySet): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO key_set (id, json_web_key_set) VALUES (1, ?)')
      .run(JSON.stringify(jwks))
  }

  async loadKeys(): Promise<JSONWebKeySet | null> {
    const row = this.db.prepare('SELECT json_web_key_set FROM key_set WHERE id = 1').get() as {
      json_web_key_set: string
    } | null
    if (!row) return null
    return JSON.parse(row.json_web_key_set)
  }
}
