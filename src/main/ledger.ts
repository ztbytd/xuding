import type { DatabaseConnection } from './sqlite'
import { randomUUID } from 'node:crypto'
import { addDays, localDate, occurrences } from '../shared/billing'
import {
  billInputSchema,
  billRecordSchema,
  billUpdateSchema,
  ledgerChangeSchema,
  priceAt,
  priceInputSchema,
  priceSchema,
  trackingSchema
} from '../shared/ledger-model'
import type {
  BillInput,
  BillRecord,
  BillUpdate,
  LedgerChange,
  Price,
  PriceInput,
  Tracking
} from '../shared/ledger-model'
import type { Subscription } from '../shared/model'
import type { ExchangeRates } from '../shared/exchange'

export class LedgerStore {
  constructor(
    private db: DatabaseConnection,
    private subscriptions: () => Subscription[],
    private now = () => new Date()
  ) {}
  private today() {
    return localDate(this.now())
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = work()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private all(table: 'bills' | 'prices' | 'ledger_changes' | 'billing_tracking'): unknown[] {
    return this.db
      .prepare(`SELECT document FROM ${table}`)
      .all()
      .map((r) => JSON.parse(String(r.document)))
  }
  bills(): BillRecord[] {
    return this.all('bills')
      .map((v) => billRecordSchema.parse(v))
      .sort((a, b) => b.due.localeCompare(a.due) || a.id.localeCompare(b.id))
  }
  prices(): Price[] {
    return this.all('prices')
      .map((v) => priceSchema.parse(v))
      .sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn))
  }
  changes(): LedgerChange[] {
    return this.all('ledger_changes')
      .map((v) => ledgerChangeSchema.parse(v))
      .sort((a, b) => b.changedAt.localeCompare(a.changedAt))
  }
  tracking(): Tracking[] {
    return this.all('billing_tracking').map((v) => trackingSchema.parse(v))
  }
  private changed() {
    this.db.prepare('INSERT INTO ledger_events DEFAULT VALUES').run()
  }
  private log(subscriptionId: string, label: string, billId?: string) {
    const item: LedgerChange = {
      id: randomUUID(),
      subscriptionId,
      label,
      billId,
      changedAt: this.now().toISOString()
    }
    this.db
      .prepare('INSERT INTO ledger_changes VALUES(?,?,?)')
      .run(item.id, subscriptionId, JSON.stringify(item))
    this.changed()
  }
  private writePrice(item: Price) {
    this.db
      .prepare(
        'INSERT INTO prices VALUES(?,?,?,?) ON CONFLICT(subscription_id,effective_on) DO UPDATE SET id=excluded.id,document=excluded.document'
      )
      .run(item.id, item.subscriptionId, item.effectiveOn, JSON.stringify(item))
  }
  // Called inside the subscription transaction, including migration/import.
  ensure(s: Subscription) {
    const today = this.today()
    this.db
      .prepare('INSERT OR IGNORE INTO billing_tracking VALUES(?,?)')
      .run(
        s.id,
        JSON.stringify({ subscriptionId: s.id, startedOn: today, through: addDays(today, -1) })
      )
    if (!this.db.prepare('SELECT id FROM prices WHERE subscription_id=?').get(s.id))
      this.writePrice({
        amountMinor: s.amountMinor,
        currency: s.currency,
        id: randomUUID(),
        subscriptionId: s.id,
        effectiveOn: '1970-01-01',
        createdAt: this.now().toISOString()
      })
  }
  reconsiderToday(id: string) {
    const row = this.db
      .prepare('SELECT document FROM billing_tracking WHERE subscription_id=?')
      .get(id)
    if (!row) return
    const cursor = trackingSchema.parse(JSON.parse(String(row.document)))
    if (cursor.through === this.today())
      this.db
        .prepare('UPDATE billing_tracking SET document=? WHERE subscription_id=?')
        .run(JSON.stringify({ ...cursor, through: addDays(this.today(), -1) }), id)
  }
  recordPrice(s: Subscription) {
    const value = priceAt(s, this.today(), this.prices())
    if (value.amountMinor === s.amountMinor && value.currency === s.currency) return
    const item = priceSchema.parse({
      id: randomUUID(),
      subscriptionId: s.id,
      effectiveOn: this.today(),
      amountMinor: s.amountMinor,
      currency: s.currency,
      createdAt: this.now().toISOString()
    })
    this.writePrice(item)
    this.log(
      s.id,
      `价格调整为 ${s.currency} ${(s.amountMinor / 100).toFixed(2)}，${item.effectiveOn} 生效`
    )
  }
  changePrice(raw: PriceInput) {
    const input = priceInputSchema.parse(raw)
    if (input.effectiveOn < this.today())
      throw new Error('价格生效日期不能早于今天，历史账单可单独编辑。')
    if (!this.subscriptions().some((s) => s.id === input.subscriptionId))
      throw new Error('订阅不存在。')
    this.sync()
    this.transaction(() => {
      const item = priceSchema.parse({
        ...input,
        id: randomUUID(),
        createdAt: this.now().toISOString()
      })
      this.writePrice(item)
      this.log(
        item.subscriptionId,
        `价格调整为 ${item.currency} ${(item.amountMinor / 100).toFixed(2)}，${item.effectiveOn} 生效`
      )
    })
  }
  sync(): boolean {
    const today = this.today(),
      tracking = this.tracking(),
      prices = this.prices()
    let changed = false
    this.transaction(() => {
      for (const s of this.subscriptions()) {
        const cursor = tracking.find((t) => t.subscriptionId === s.id)
        if (!cursor || cursor.through >= today) continue
        const start =
          cursor.through < cursor.startedOn ? cursor.startedOn : addDays(cursor.through, 1)
        for (const bill of occurrences(s, start, today, 2000, prices)) {
          if (
            this.db
              .prepare('SELECT id FROM bills WHERE subscription_id=? AND due=?')
              .get(s.id, bill.due)
          )
            continue
          const item = billRecordSchema.parse({
            id: randomUUID(),
            subscriptionId: s.id,
            due: bill.due,
            amountMinor: bill.amountMinor,
            currency: bill.currency,
            category: s.category,
            status: 'pending',
            manual: false,
            payment: null,
            rates: null,
            createdAt: this.now().toISOString(),
            updatedAt: this.now().toISOString()
          })
          const inserted = this.db
            .prepare('INSERT OR IGNORE INTO bills VALUES(?,?,?,?,?)')
            .run(item.id, s.id, bill.due, 0, JSON.stringify(item))
          if (inserted.changes) this.log(s.id, '生成待确认账单', item.id)
        }
        this.db
          .prepare('UPDATE billing_tracking SET document=? WHERE subscription_id=?')
          .run(JSON.stringify({ ...cursor, through: today }), s.id)
        changed = true
      }
      if (changed) this.changed()
    })
    return changed
  }
  private writeBill(item: BillRecord) {
    this.db
      .prepare(
        'INSERT INTO bills VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document'
      )
      .run(item.id, item.subscriptionId, item.due, item.manual ? 1 : 0, JSON.stringify(item))
  }
  addBill(raw: BillInput, rates: ExchangeRates | null): BillRecord {
    const input = billInputSchema.parse(raw),
      s = this.subscriptions().find((s) => s.id === input.subscriptionId)
    if (!s) throw new Error('订阅不存在。')
    if (input.payment.paidOn > this.today() || input.due > this.today())
      throw new Error('补录账单和支付日期不能晚于今天。')
    this.sync()
    if (
      this.bills().some(
        (b) => b.subscriptionId === s.id && b.due === input.due && b.status !== 'skipped'
      )
    )
      throw new Error('该日期已有账单，请编辑或确认现有账单，避免重复计费。')
    const item = billRecordSchema.parse({
      id: randomUUID(),
      subscriptionId: s.id,
      due: input.due,
      ...priceAt(s, input.due, this.prices()),
      category: s.category,
      status: 'paid',
      manual: true,
      payment: input.payment,
      rates,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString()
    })
    this.transaction(() => {
      this.writeBill(item)
      this.log(s.id, '补录已支付账单', item.id)
    })
    return item
  }
  updateBill(raw: BillUpdate, rates: ExchangeRates | null): BillRecord {
    const input = billUpdateSchema.parse(raw)
    const previous = this.bills().find((b) => b.id === input.id)
    if (!previous) throw new Error('账单不存在。')
    if (previous.updatedAt !== input.expectedUpdatedAt)
      throw new Error('账单已发生变化，请刷新后重试。')
    if (input.payment && input.payment.paidOn > this.today())
      throw new Error('支付日期不能晚于今天。')
    // Editing an existing payment preserves its original conversion snapshot.
    const item = billRecordSchema.parse({
      ...previous,
      conversion:
        input.status !== 'paid'
          ? undefined
          : previous.conversion?.source === 'manual' &&
              (input.payment?.amountMinor !== previous.payment?.amountMinor ||
                input.payment?.currency !== previous.payment?.currency)
            ? { source: 'confirmation' }
            : previous.conversion,
      status: input.status,
      payment: input.payment ?? null,
      rates:
        input.status === 'paid'
          ? previous.status === 'paid' && previous.rates
            ? previous.rates
            : rates
          : null,
      updatedAt: new Date(
        Math.max(this.now().getTime(), Date.parse(previous.updatedAt) + 1)
      ).toISOString()
    })
    this.transaction(() => {
      this.writeBill(item)
      this.log(
        item.subscriptionId,
        `${input.status === 'paid' ? (previous.status === 'paid' ? '修改支付记录' : '确认支付') : input.status === 'skipped' ? '跳过本期账单' : '撤销账单确认'}${input.payment ? `：${input.payment.currency} ${(input.payment.amountMinor / 100).toFixed(2)}，支付日期 ${input.payment.paidOn}` : ''}`,
        item.id
      )
    })
    return item
  }
  importPrice(s: Subscription, effectiveOn: string) {
    this.writePrice(
      priceSchema.parse({
        id: randomUUID(),
        subscriptionId: s.id,
        amountMinor: s.amountMinor,
        currency: s.currency,
        effectiveOn,
        createdAt: this.now().toISOString()
      })
    )
    this.log(
      s.id,
      `CSV 更新价格 ${s.currency} ${(s.amountMinor / 100).toFixed(2)}，${effectiveOn} 生效`
    )
  }
  importBill(item: BillRecord) {
    const old = this.bills().find((b) => b.id === item.id)
    if (old && old.subscriptionId !== item.subscriptionId)
      throw new Error('账单 ID 与其他订阅冲突。')
    this.writeBill(billRecordSchema.parse(item))
    this.log(item.subscriptionId, 'CSV 导入账单', item.id)
  }
  import(
    rows: { bills: BillRecord[]; prices: Price[]; changes: LedgerChange[]; tracking: Tracking[] },
    subscriptionIds: string[]
  ) {
    for (const [table, records] of [
      ['bills', rows.bills],
      ['prices', rows.prices],
      ['ledger_changes', rows.changes]
    ] as const) {
      for (const row of records) {
        const existing = this.db
          .prepare(`SELECT subscription_id FROM ${table} WHERE id=?`)
          .get(row.id)
        if (existing && !subscriptionIds.includes(String(existing.subscription_id)))
          throw new Error('备份中的记录 ID 与其他订阅冲突，已停止恢复。')
      }
    }
    for (const id of subscriptionIds)
      for (const table of ['bills', 'prices', 'ledger_changes', 'billing_tracking'])
        this.db.prepare(`DELETE FROM ${table} WHERE subscription_id=?`).run(id)
    for (const p of rows.prices) this.writePrice(p)
    for (const b of rows.bills) this.writeBill(b)
    for (const c of rows.changes)
      this.db
        .prepare('INSERT INTO ledger_changes VALUES(?,?,?)')
        .run(c.id, c.subscriptionId, JSON.stringify(c))
    for (const t of rows.tracking)
      this.db
        .prepare('INSERT INTO billing_tracking VALUES(?,?)')
        .run(t.subscriptionId, JSON.stringify(t))
    this.changed()
  }
}
