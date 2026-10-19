import { DatabaseSync } from 'node:sqlite'
import { LedgerStore } from './ledger'
import { localDate } from '../shared/billing'
import { priceAt } from '../shared/ledger-model'
import { randomUUID } from 'node:crypto'
import {
  backupSchema,
  settingsSchema,
  settingsPatchSchema,
  subscriptionInputSchema,
  subscriptionSchema
} from '../shared/model'
import type {
  Backup,
  Settings,
  SettingsPatch,
  Subscription,
  SubscriptionInput
} from '../shared/model'
import { exchangeRatesSchema } from '../shared/exchange'
import type { ExchangeRates } from '../shared/exchange'

export class SubscriptionRepository {
  private db: DatabaseSync
  readonly ledger: LedgerStore
  constructor(
    path: string,
    private now = () => new Date()
  ) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version
    if (version > 3) {
      this.db.close()
      throw new Error('数据库由较新版本创建，请升级续订后再打开。')
    }
    if (version > 0 && version < 3 && path !== ':memory:') {
      const snapshot = path + '.pre-v3-' + Date.now() + '.db'
      this.db.exec("VACUUM INTO '" + snapshot.replaceAll("'", "''") + "'")
    }
    if (version === 0)
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE subscriptions (id TEXT PRIMARY KEY, document TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE subscription_changes (id INTEGER PRIMARY KEY, subscription_id TEXT NOT NULL, document TEXT NOT NULL, changed_at TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE reminders (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL);
      PRAGMA user_version=2;
      COMMIT;
    `)
    this.ledger = new LedgerStore(this.db, () => this.rawList(), this.now)
    if (version < 3)
      this.transaction(() => {
        this.db.exec(`
        CREATE TABLE bills(id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id), due TEXT NOT NULL, manual INTEGER NOT NULL, document TEXT NOT NULL);
        CREATE UNIQUE INDEX scheduled_bill ON bills(subscription_id,due) WHERE manual=0;
        CREATE TABLE prices(id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id), effective_on TEXT NOT NULL, document TEXT NOT NULL, UNIQUE(subscription_id,effective_on));
        CREATE TABLE ledger_changes(id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id), document TEXT NOT NULL);
        CREATE TABLE billing_tracking(subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id), document TEXT NOT NULL);
        CREATE TABLE ledger_events(id INTEGER PRIMARY KEY AUTOINCREMENT);
      `)
        for (const item of this.rawList()) this.ledger.ensure(item)
        this.db.exec('PRAGMA user_version=3')
      })
  }
  list(): Subscription[] {
    const prices = this.ledger.prices()
    return this.rawList().map((s) => ({ ...s, ...priceAt(s, localDate(this.now()), prices) }))
  }
  private rawList(): Subscription[] {
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
    this.ledger.sync()
    const previous = id ? this.get(id) : undefined
    if (id && !previous) throw new Error('订阅不存在，请刷新后重试。')
    const now = this.now().toISOString()
    const item = subscriptionSchema.parse({
      ...input,
      id: id || randomUUID(),
      createdAt: previous?.createdAt || now,
      updatedAt: now
    })
    this.transaction(() => {
      this.upsert(item)
      this.audit(item)
      this.ledger.ensure(item)
      this.ledger.recordPrice(item)
      if (
        previous &&
        (previous.anchorDate !== item.anchorDate ||
          previous.cycle !== item.cycle ||
          previous.interval !== item.interval ||
          previous.autoRenew !== item.autoRenew ||
          previous.status !== item.status)
      )
        this.ledger.reconsiderToday(item.id)
    })
    this.ledger.sync()
    return { ...item, ...priceAt(item, localDate(this.now()), this.ledger.prices()) }
  }
  archive(id: string): void {
    const previous = this.list().find((s) => s.id === id)
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
    return row ? settingsSchema.parse(JSON.parse(String(row.value))) : settingsSchema.parse({})
  }
  saveSettings(input: SettingsPatch): Settings {
    const value = settingsSchema.parse({ ...this.settings(), ...settingsPatchSchema.parse(input) })
    if (!value.launchAtLogin) value.startInTray = false
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(JSON.stringify(value))
    return value
  }
  revision(): number {
    return Number(
      this.db
        .prepare(
          'SELECT (SELECT COALESCE(MAX(id),0) FROM subscription_changes) + (SELECT COALESCE(MAX(id),0) FROM ledger_events) AS revision'
        )
        .get()!.revision
    )
  }
  metadata(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)
    try {
      return row ? JSON.parse(String(row.value)) : null
    } catch {
      return null
    }
  }
  saveMetadata(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(key, JSON.stringify(value))
  }
  export(): Backup {
    return {
      format: 'xuding',
      version: 2,
      bills: this.ledger.bills(),
      prices: this.ledger.prices(),
      changes: this.ledger.changes(),
      tracking: this.ledger.tracking(),
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
        if (backup.version === 1) {
          this.ledger.ensure(item)
          this.ledger.recordPrice(item)
        }
      }
      if (backup.version === 2)
        this.ledger.import(
          backup,
          backup.subscriptions.map((s) => s.id)
        )
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
