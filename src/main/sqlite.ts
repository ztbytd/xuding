import { DatabaseSync as PlainDatabase } from 'node:sqlite'
import CipherDatabase from 'better-sqlite3-multiple-ciphers'

export interface DatabaseConnection {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...args: any[]): any
    all(...args: any[]): any[]
    run(...args: any[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  }
  close(): void
}

export function openDatabase(path: string, key?: Buffer, readOnly = false): DatabaseConnection {
  if (!key) return new PlainDatabase(path, { readOnly })
  const db = new CipherDatabase(path, { readonly: readOnly, fileMustExist: readOnly })
  try {
    db.pragma("cipher='sqlcipher'")
    db.pragma('legacy=4')
    db.key(key)
    db.exec('PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON;')
    db.prepare('SELECT count(*) FROM sqlite_master').get()
    return db as DatabaseConnection
  } catch (error) {
    db.close()
    throw error
  }
}
