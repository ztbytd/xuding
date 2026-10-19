import { openDatabase } from './sqlite'
import type { DatabaseConnection } from './sqlite'
import { DecisionStore } from './decisions'
import { FinanceStore } from './finance'
import type { CsvOperation } from '../shared/csv-model'
import type { ImportBatch } from '../shared/analytics-model'
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
  private db: DatabaseConnection
  readonly ledger: LedgerStore
  readonly finance: FinanceStore
  readonly decisions: DecisionStore
  constructor(
    path: string,
    private now = () => new Date(),
    key?: Buffer
  ) {
    this.db = openDatabase(path, key)
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version
      if (version > 5) {
        throw new Error('数据库由较新版本创建，请升级续订后再打开。')
      }
      if (version > 0 && version < 4 && path !== ':memory:') {
        const snapshot = path + '.pre-v4-' + Date.now() + '.db'
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
      this.finance = new FinanceStore(this.db, this.now)
      if (version < 4)
        this.transaction(() => {
          this.db.exec(`CREATE TABLE budgets(month TEXT PRIMARY KEY, document TEXT NOT NULL);
        CREATE TABLE budget_reminders(key TEXT PRIMARY KEY,sent_at TEXT NOT NULL);
        CREATE TABLE import_batches(id TEXT PRIMARY KEY,document TEXT NOT NULL,created_at TEXT NOT NULL);
        PRAGMA user_version=4;`)
        })
      if (version < 5)
        this.transaction(() => {
          this.db
            .exec(`CREATE TABLE usage_records(id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id), day TEXT NOT NULL, document TEXT NOT NULL, UNIQUE(subscription_id,day));
          CREATE TABLE decisions(subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id),document TEXT NOT NULL);
          CREATE TABLE sync_local(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE sync_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
          PRAGMA user_version=5;`)
        })
      this.decisions = new DecisionStore(
        this.db,
        () => this.rawList(),
        (input, id) => this.save(input, id),
        this.now
      )
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS subscription_history_owner ON subscription_changes(subscription_id)'
      )
      // Every business write, including ledger/CSV/restore, marks pending sync in its own transaction.
      for (const table of [
        'subscriptions',
        'bills',
        'prices',
        'ledger_changes',
        'billing_tracking',
        'budgets',
        'import_batches',
        'usage_records',
        'decisions'
      ]) {
        for (const op of ['INSERT', 'UPDATE', 'DELETE'])
          this.db.exec(
            `CREATE TRIGGER IF NOT EXISTS sync_${table}_${op} AFTER ${op} ON ${table} BEGIN INSERT INTO sync_outbox DEFAULT VALUES; END;`.replace(
              'INSERT INTO sync_outbox DEFAULT VALUES',
              'INSERT INTO sync_outbox(created_at) VALUES(CURRENT_TIMESTAMP)'
            )
          )
      }
    } catch (error) {
      this.db.close()
      throw error
    }
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
    this.db.exec('SAVEPOINT repository_write')
    try {
      work()
      this.db.exec('RELEASE repository_write')
    } catch (error) {
      this.db.exec('ROLLBACK TO repository_write; RELEASE repository_write')
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
      version: 4,
      usage: this.decisions.usage(),
      decisions: this.decisions.list(),
      histories: this.history(),
      rateHistory: this.rateHistory(),
      budgets: this.finance.budgets(),
      budgetReminders: this.finance.reminders(),
      importBatches: this.finance.batches(),
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
  import(raw: unknown, replace = false): number {
    const backup = backupSchema.parse(raw)
    const previousRevision = this.revision()
    if (replace && backup.version < 3)
      throw new Error('完整恢复需要 v0.4 或更新版本导出的新版备份。')
    this.transaction(() => {
      if (replace)
        this.db.exec(
          'DELETE FROM usage_records;DELETE FROM decisions;DELETE FROM ledger_changes;DELETE FROM bills;DELETE FROM prices;DELETE FROM billing_tracking;DELETE FROM subscriptions;DELETE FROM subscription_changes;'
        )
      for (const item of backup.subscriptions) {
        this.upsert(item)
        this.audit(item)
        if (backup.version === 1) {
          this.ledger.ensure(item)
          this.ledger.recordPrice(item)
        }
      }
      if (backup.version >= 2)
        this.ledger.import(
          backup as Exclude<Backup, { version: 1 }>,
          backup.subscriptions.map((s) => s.id)
        )
      if (backup.version >= 3)
        this.finance.import(backup as Extract<Backup, { version: 3 | 4 }>, replace)
      if (backup.version === 4) {
        this.decisions.import(backup)
        for (const item of backup.histories)
          if (
            !this.db
              .prepare(
                'SELECT 1 FROM subscription_changes WHERE subscription_id=? AND document=? LIMIT 1'
              )
              .get(item.id, JSON.stringify(item))
          )
            this.db
              .prepare(
                'INSERT INTO subscription_changes(subscription_id,document,changed_at) VALUES(?,?,?)'
              )
              .run(item.id, JSON.stringify(item), item.updatedAt)
        this.saveMetadata('rate-history', backup.rateHistory)
      }
      if (this.revision() <= previousRevision)
        this.db.prepare('INSERT INTO ledger_events(id) VALUES(?)').run(previousRevision + 1)
    })
    return backup.subscriptions.length
  }
  commitCsv(operations: CsvOperation[], batch: ImportBatch, expectedRevision: number) {
    if (expectedRevision !== this.revision()) throw new Error('账本已发生变化，请重新预览后导入。')
    this.transaction(() => {
      for (const op of operations) {
        if (op.kind === 'subscription') {
          const previous = this.get(op.item.id)
          this.upsert(op.item)
          this.audit(op.item)
          this.ledger.ensure(op.item)
          this.ledger.importPrice(op.item, op.effectiveOn)
          if (
            previous &&
            (previous.anchorDate !== op.item.anchorDate ||
              previous.autoRenew !== op.item.autoRenew ||
              previous.status !== op.item.status ||
              previous.cycle !== op.item.cycle ||
              previous.interval !== op.item.interval)
          )
            this.ledger.reconsiderToday(op.item.id)
        } else {
          if (op.createSubscription) {
            const { id, ...input } = op.createSubscription
            const item = subscriptionSchema.parse({
              ...input,
              id,
              createdAt: this.now().toISOString(),
              updatedAt: this.now().toISOString()
            })
            this.upsert(item)
            this.audit(item)
            this.ledger.ensure(item)
          }
          this.ledger.importBill(op.item)
        }
      }
      this.finance.recordBatch(batch)
    })
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
  syncMetadata(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM sync_local WHERE key=?').get(key)
    return row ? JSON.parse(String(row.value)) : null
  }
  saveSyncMetadata(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO sync_local VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(key, JSON.stringify(value))
  }
  pendingSync(): number {
    return Number(this.db.prepare('SELECT count(*) AS n FROM sync_outbox').get().n)
  }
  acknowledgeSync(): void {
    this.db.exec('DELETE FROM sync_outbox')
  }
  atomic<T>(work: () => T): T {
    this.db.exec('SAVEPOINT repository_atomic')
    try {
      const result = work()
      this.db.exec('RELEASE repository_atomic')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK TO repository_atomic; RELEASE repository_atomic')
      throw e
    }
  }
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }
  markPendingSync(): void {
    this.db.prepare('INSERT INTO sync_outbox DEFAULT VALUES').run()
  }
  history(): Subscription[] {
    const ids = new Set(this.rawList().map((s) => s.id)),
      unique = new Map<string, Subscription>()
    for (const row of this.db
      .prepare('SELECT document FROM subscription_changes ORDER BY id')
      .all()) {
      const item = subscriptionSchema.parse(JSON.parse(row.document))
      if (ids.has(item.id)) unique.set(item.id + ':' + item.updatedAt, item)
    }
    return [...unique.values()]
  }
  rateHistory(): ExchangeRates[] {
    const value = this.metadata('rate-history')
    return Array.isArray(value)
      ? value.flatMap((v) => {
          const r = exchangeRatesSchema.safeParse(v)
          return r.success ? [r.data] : []
        })
      : []
  }
  recordRate(table: ExchangeRates): void {
    if (this.rateHistory().some((v) => v.date === table.date)) return
    this.saveMetadata('rate-history', [...this.rateHistory(), table].slice(-4000))
    this.markPendingSync()
  }
}
