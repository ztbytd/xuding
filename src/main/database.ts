import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import {
  backupSchema,
  settingsSchema,
  subscriptionInputSchema,
  subscriptionSchema
} from '../shared/model'
import type { Backup, Settings, Subscription, SubscriptionInput } from '../shared/model'
import { exchangeRatesSchema } from '../shared/exchange'
import type { ExchangeRates } from '../shared/exchange'

export class SubscriptionRepository {
  private db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version
    if (version > 1) {
      this.db.close()
      throw new Error('数据库由较新版本创建，请升级续订后再打开。')
    }
    if (version === 0)
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE subscriptions (id TEXT PRIMARY KEY, document TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE subscription_changes (id INTEGER PRIMARY KEY, subscription_id TEXT NOT NULL, document TEXT NOT NULL, changed_at TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE reminders (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL);
      PRAGMA user_version=1;
      COMMIT;
    `)
  }
  list(): Subscription[] {
    return this.db
      .prepare('SELECT document FROM subscriptions ORDER BY updated_at DESC, id')
      .all()
      .map((row) => subscriptionSchema.parse(JSON.parse(String(row.document))))
  }
  private get(id: string): Subscription | undefined {
    const row = this.db.prepare('SELECT document FROM subscriptions WHERE id=?').get(id)
    return row ? subscriptionSchema.parse(JSON.parse(String(row.document))) : undefined
  }
  save(raw: SubscriptionInput, id?: string): Subscription {
    const input = subscriptionInputSchema.parse(raw)
    const previous = id ? this.get(id) : undefined
    if (id && !previous) throw new Error('订阅不存在，请刷新后重试。')
    const now = new Date().toISOString()
    const item = subscriptionSchema.parse({
      ...input,
      id: id || randomUUID(),
      createdAt: previous?.createdAt || now,
      updatedAt: now
    })
    this.transaction(() => {
      this.upsert(item)
      this.audit(item)
    })
    return item
  }
  archive(id: string): void {
    const previous = this.get(id)
    if (!previous) throw new Error('订阅不存在。')
    const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = previous
    this.save({ ...input, status: 'archived', autoRenew: false }, id)
  }
  private upsert(item: Subscription): void {
    this.db
      .prepare(
        'INSERT INTO subscriptions(id,document,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at'
      )
      .run(item.id, JSON.stringify(item), item.updatedAt)
  }
  private audit(item: Subscription): void {
    this.db
      .prepare(
        'INSERT INTO subscription_changes(subscription_id,document,changed_at) VALUES(?,?,?)'
      )
      .run(item.id, JSON.stringify(item), new Date().toISOString())
  }
  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  settings(): Settings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='preferences'").get()
    return row
      ? settingsSchema.parse(JSON.parse(String(row.value)))
      : { notificationsEnabled: false }
  }
  saveSettings(input: Settings): Settings {
    const value = settingsSchema.parse(input)
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(JSON.stringify(value))
    return value
  }
  export(): Backup {
    return {
      format: 'xuding',
      version: 1,
      exportedAt: new Date().toISOString(),
      subscriptions: this.list()
    }
  }
  exchangeRates(): ExchangeRates | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='exchange-rates'").get()
    try {
      return row ? exchangeRatesSchema.parse(JSON.parse(String(row.value))) : null
    } catch {
      return null
    }
  }
  saveExchangeRates(table: ExchangeRates): void {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES('exchange-rates',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(JSON.stringify(exchangeRatesSchema.parse(table)))
  }
  import(raw: unknown): number {
    const backup = backupSchema.parse(raw)
    this.transaction(() => {
      for (const item of backup.subscriptions) {
        this.upsert(item)
        this.audit(item)
      }
    })
    return backup.subscriptions.length
  }
  hasReminder(key: string): boolean {
    return Boolean(this.db.prepare('SELECT key FROM reminders WHERE key=?').get(key))
  }
  markReminder(key: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO reminders(key,sent_at) VALUES(?,?)')
      .run(key, new Date().toISOString())
  }
  close(): void {
    this.db.close()
  }
}
