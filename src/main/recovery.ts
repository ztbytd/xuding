import { openDatabase } from './sqlite'
import CipherDatabase from 'better-sqlite3-multiple-ciphers'
import { openSync, readSync, closeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { copyFile, lstat, readdir, rename, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { RecoveryEntry } from '../shared/operations-model'
import { backupSchema } from '../shared/model'

function databaseKey(path: string, key?: Buffer): Buffer | undefined {
  const fd = openSync(path, 'r'),
    header = Buffer.alloc(16)
  try {
    readSync(fd, header, 0, 16, 0)
  } finally {
    closeSync(fd)
  }
  return header.toString('utf8') === 'SQLite format 3\0' ? undefined : key
}
const snapshotName = /^(xuding\.db\.pre-v[345]-\d+|upgrade-\d+\.\d+\.\d+-\d+-[a-f0-9-]{36})\.db$/
export function inspectDatabase(path: string, key?: Buffer): number {
  const db = openDatabase(path, databaseKey(path, key), true)
  try {
    const result = db.prepare('PRAGMA quick_check').get() as { quick_check: string }
    if (result.quick_check !== 'ok') throw new Error('数据库完整性检查未通过。')
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version
    if (version < 1 || version > 5) throw new Error('数据库结构不兼容，请使用对应版本的续订。')
    for (const table of ['subscriptions', 'settings'])
      db.prepare(`SELECT * FROM ${table} LIMIT 1`).get()
    if (version >= 3)
      for (const table of ['bills', 'prices', 'billing_tracking', 'ledger_events'])
        db.prepare(`SELECT * FROM ${table} LIMIT 1`).get()
    if (version >= 4)
      for (const table of ['budgets', 'import_batches'])
        db.prepare(`SELECT * FROM ${table} LIMIT 1`).get()
    const documents = (table: string) =>
      db
        .prepare(`SELECT document FROM ${table}`)
        .all()
        .map((row) => JSON.parse(String(row.document)))
    backupSchema.parse({
      format: 'xuding',
      exportedAt: new Date().toISOString(),
      version: version >= 5 ? 4 : version >= 4 ? 3 : version >= 3 ? 2 : 1,
      subscriptions: documents('subscriptions'),
      ...(version >= 5
        ? { usage: documents('usage_records'), decisions: documents('decisions') }
        : {}),
      ...(version >= 3
        ? {
            bills: documents('bills'),
            prices: documents('prices'),
            changes: documents('ledger_changes'),
            tracking: documents('billing_tracking')
          }
        : {}),
      ...(version >= 4
        ? {
            budgets: documents('budgets'),
            importBatches: documents('import_batches'),
            budgetReminders: []
          }
        : {})
    })
    return version
  } finally {
    db.close()
  }
}
export class RecoveryService {
  readonly database: string
  private checkpoint: string | null = null
  constructor(
    private directory: string,
    private version: string,
    private key: () => Buffer | undefined = () => undefined,
    private keys: () => Buffer[] = () => (this.key() ? [this.key()!] : [])
  ) {
    this.database = join(directory, 'xuding.db')
  }
  private sourceKey(path: string): Buffer | undefined {
    if (!databaseKey(path, this.key())) return undefined
    for (const key of this.keys())
      try {
        inspectDatabase(path, key)
        return key
      } catch {}
    throw new Error('副本需要其他加密密钥，或文件已损坏。')
  }
  async beforeOpen(): Promise<void> {
    if (!existsSync(this.database)) return
    const info = await lstat(this.database)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('账本必须是普通数据库文件。')
    inspectDatabase(this.database, this.key())
    const db = openDatabase(this.database, databaseKey(this.database, this.key()))
    try {
      const row = db
        .prepare("SELECT value FROM settings WHERE key='last-success-version'")
        .get() as { value: string } | undefined
      if (row?.value === JSON.stringify(this.version)) return
      this.checkpoint = `upgrade-${this.version}-${Date.now()}-${randomUUID()}.db`
      const path = join(this.directory, this.checkpoint)
      db.exec("VACUUM INTO '" + path.replaceAll("'", "''") + "'")
      inspectDatabase(path, this.key())
    } finally {
      db.close()
    }
  }
  checkpointNow(): string {
    const id = `upgrade-${this.version}-${Date.now()}-${randomUUID()}.db`
    const db = openDatabase(this.database, databaseKey(this.database, this.key()))
    try {
      db.exec("VACUUM INTO '" + join(this.directory, id).replaceAll("'", "''") + "'")
    } finally {
      db.close()
    }
    inspectDatabase(join(this.directory, id), this.key())
    return id
  }
  async successful(): Promise<void> {
    const entries = (await this.entries())
      .filter((v) => v.valid)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    // Cleanup is only reached after successful startup; keep at least three verified points.
    for (const entry of entries.slice(3))
      if (entry.id !== this.checkpoint) await unlink(await this.safePath(entry.id)).catch(() => {})
  }
  private async safePath(id: string): Promise<string> {
    if (!snapshotName.test(id) || basename(id) !== id) throw new Error('恢复副本无效。')
    const path = join(this.directory, id),
      info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('恢复副本必须是普通文件。')
    return path
  }
  async entries(): Promise<RecoveryEntry[]> {
    const results: RecoveryEntry[] = []
    for (const id of (await readdir(this.directory)).filter((v) => snapshotName.test(v))) {
      try {
        const path = await this.safePath(id),
          info = await lstat(path)
        let version: number | null = null
        try {
          version = inspectDatabase(path, this.sourceKey(path))
        } catch {
          /* show unusable checkpoint */
        }
        results.push({
          id,
          createdAt: info.mtime.toISOString(),
          size: info.size,
          valid: version !== null,
          version
        })
      } catch {
        /* ignore links and unrelated files */
      }
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async restore(id: string): Promise<void> {
    const source = await this.safePath(id)
    const sourceKey = this.sourceKey(source)
    inspectDatabase(source, sourceKey)
    const temporary = join(this.directory, `restore-${randomUUID()}.db`)
    const suffix = `.fault-${Date.now()}-${randomUUID()}`
    const moved: { from: string; to: string }[] = []
    try {
      await copyFile(source, temporary)
      if (this.key() && (!sourceKey || !sourceKey.equals(this.key()!))) {
        const db = new CipherDatabase(temporary)
        try {
          db.pragma("cipher='sqlcipher'")
          db.pragma('legacy=4')
          if (sourceKey) db.key(sourceKey)
          db.rekey(this.key()!)
        } finally {
          db.close()
        }
      }
      inspectDatabase(temporary, this.key())
      for (const extension of ['', '-wal', '-shm']) {
        const from = this.database + extension
        if (!existsSync(from)) continue
        const info = await lstat(from)
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error('数据库关联文件无效，已停止恢复。')
        const to = from + suffix
        await rename(from, to)
        moved.push({ from, to })
      }
      await rename(temporary, this.database)
    } catch (error) {
      for (const item of moved.reverse()) await rename(item.to, item.from)
      throw error
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
}
