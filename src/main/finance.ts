import { DatabaseSync } from 'node:sqlite'
import {
  budgetInputSchema,
  budgetSchema,
  budgetReminderSchema,
  importBatchSchema
} from '../shared/analytics-model'
import type { Budget, BudgetInput, BudgetReminder, ImportBatch } from '../shared/analytics-model'
import { localDate } from '../shared/billing'
import { shiftMonth } from '../shared/analytics'

export class FinanceStore {
  constructor(
    private db: DatabaseSync,
    private now = () => new Date()
  ) {}
  private changed() {
    this.db.prepare('INSERT INTO ledger_events DEFAULT VALUES').run()
  }
  budgets(): Budget[] {
    return this.db
      .prepare('SELECT document FROM budgets ORDER BY month')
      .all()
      .map((r) => budgetSchema.parse(JSON.parse(String(r.document))))
  }
  batches(): ImportBatch[] {
    return this.db
      .prepare('SELECT document FROM import_batches ORDER BY created_at DESC')
      .all()
      .map((r) => importBatchSchema.parse(JSON.parse(String(r.document))))
  }
  reminders(): BudgetReminder[] {
    return this.db
      .prepare('SELECT key,sent_at AS sentAt FROM budget_reminders')
      .all()
      .map((r) => budgetReminderSchema.parse(r))
  }
  private write(budget: Budget) {
    this.db
      .prepare(
        'INSERT INTO budgets VALUES(?,?) ON CONFLICT(month) DO UPDATE SET document=excluded.document'
      )
      .run(budget.month, JSON.stringify(budget))
  }
  ensureMonths(): boolean {
    const last = this.budgets().at(-1),
      current = localDate(this.now()).slice(0, 7)
    if (!last || last.month >= current) return false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (let month = shiftMonth(last.month, 1); month <= current; month = shiftMonth(month, 1))
        this.write({ ...last, month, updatedAt: this.now().toISOString() })
      this.changed()
      this.db.exec('COMMIT')
      return true
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  save(raw: BudgetInput): Budget {
    const input = budgetInputSchema.parse(raw)
    if (input.month > localDate(this.now()).slice(0, 7))
      throw new Error('请配置当前或历史月份，后续月份会自动沿用。')
    this.ensureMonths()
    const previous = this.budgets().find((b) => b.month === input.month)
    const item = budgetSchema.parse({
      ...input,
      updatedAt: new Date(
        Math.max(this.now().getTime(), previous ? Date.parse(previous.updatedAt) + 1 : 0)
      ).toISOString()
    })
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.write(item)
      this.changed()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return item
  }
  hasReminder(key: string): boolean {
    return !!this.db.prepare('SELECT key FROM budget_reminders WHERE key=?').get(key)
  }
  markReminder(key: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO budget_reminders VALUES(?,?)')
      .run(key, this.now().toISOString())
  }
  // Both called within repository transactions.
  recordBatch(batch: ImportBatch) {
    this.db
      .prepare('INSERT INTO import_batches VALUES(?,?,?)')
      .run(batch.id, JSON.stringify(importBatchSchema.parse(batch)), batch.createdAt)
    this.changed()
  }
  import(
    data: { budgets: Budget[]; budgetReminders: BudgetReminder[]; importBatches: ImportBatch[] },
    replace = false
  ) {
    if (replace)
      this.db.exec('DELETE FROM budgets;DELETE FROM budget_reminders;DELETE FROM import_batches;')
    for (const b of data.budgets) this.write(b)
    for (const r of data.budgetReminders)
      this.db.prepare('INSERT OR REPLACE INTO budget_reminders VALUES(?,?)').run(r.key, r.sentAt)
    for (const b of data.importBatches)
      this.db
        .prepare('INSERT OR REPLACE INTO import_batches VALUES(?,?,?)')
        .run(b.id, JSON.stringify(b), b.createdAt)
    this.changed()
  }
}
