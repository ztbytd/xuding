import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SubscriptionRepository } from '../src/main/database'
import { subscription } from './fixtures'
import { actualTotals, calendarBills, spendingMonths } from '../src/shared/ledger'
import { forecast, totals } from '../src/shared/billing'
import type { ExchangeRates } from '../src/shared/exchange'

describe('billing ledger and actual spending', () => {
  let repo: SubscriptionRepository, clock: Date
  const {
    id: _id,
    createdAt: _created,
    updatedAt: _updated,
    ...input
  } = subscription({ anchorDate: '2026-01-31', amountMinor: 2000, currency: 'USD' })
  const rates: ExchangeRates = {
    base: 'EUR',
    date: '2026-01-30',
    fetchedAt: '2026-01-31T04:00:00Z',
    rates: { EUR: 1, USD: 1, CNY: 7, HKD: 8 }
  }
  beforeEach(() => {
    clock = new Date('2026-01-31T12:00:00+08:00')
    repo = new SubscriptionRepository(':memory:', () => clock)
  })
  afterEach(() => repo.close())
  const pay = (id: string, amountMinor = 2000) => {
    const b = repo.ledger.bills().find((b) => b.id === id)!
    return repo.ledger.updateBill(
      {
        id,
        expectedUpdatedAt: b.updatedAt,
        status: 'paid',
        payment: { amountMinor, currency: 'USD', paidOn: '2026-01-31' }
      },
      rates
    )
  }
  it('generates once from the tracking day, catches up anchored month ends and keeps leap years', () => {
    repo.save(input)
    expect(repo.ledger.bills().map((b) => b.due)).toEqual(['2026-01-31'])
    repo.ledger.sync()
    expect(repo.ledger.bills()).toHaveLength(1)
    clock = new Date('2026-03-31T12:00:00+08:00')
    repo.ledger.sync()
    expect(repo.ledger.bills().map((b) => b.due)).toEqual([
      '2026-03-31',
      '2026-02-28',
      '2026-01-31'
    ])
    const leap = repo.save({ ...input, cycle: 'year', anchorDate: '2024-02-29' })
    clock = new Date('2028-02-29T12:00:00+08:00')
    repo.ledger.sync()
    expect(
      repo.ledger
        .bills()
        .filter((b) => b.subscriptionId === leap.id)
        .map((b) => b.due)
    ).toEqual(['2028-02-29', '2027-02-28'])
  })
  it('keeps disabled intervals out of the ledger and retains paid bills on archive', () => {
    const s = repo.save(input)
    const b = repo.ledger.bills()[0]
    pay(b.id)
    repo.save({ ...input, autoRenew: false }, s.id)
    clock = new Date('2026-03-01T12:00:00+08:00')
    repo.ledger.sync()
    repo.save(input, s.id)
    expect(repo.ledger.bills()).toHaveLength(1)
    repo.archive(s.id)
    expect(actualTotals(repo.ledger.bills(), 'CNY', '2026-01-01', '2026-01-31').total).toBe(14000)
    expect(repo.ledger.bills()[0].status).toBe('paid')
  })
  it('uses planned prices only from their effective date, preserves generated amounts and currency', () => {
    const s = repo.save(input)
    repo.ledger.changePrice({
      subscriptionId: s.id,
      effectiveOn: '2026-02-01',
      amountMinor: 3000,
      currency: 'EUR'
    })
    expect(repo.list()[0].amountMinor).toBe(2000)
    expect(
      forecast(repo.list(), '2026-01-31', '2026-02-28', undefined, repo.ledger.prices()).map(
        (b) => [b.amountMinor, b.currency]
      )
    ).toEqual([
      [2000, 'USD'],
      [3000, 'EUR']
    ])
    clock = new Date('2026-02-28T12:00:00+08:00')
    repo.ledger.sync()
    expect(repo.list()[0]).toMatchObject({ amountMinor: 3000, currency: 'EUR' })
    expect(repo.ledger.bills().map((b) => [b.amountMinor, b.currency])).toEqual([
      [3000, 'EUR'],
      [2000, 'USD']
    ])
    repo.archive(s.id)
    expect(repo.list()[0].amountMinor).toBe(3000)
    expect(() =>
      repo.ledger.changePrice({
        subscriptionId: s.id,
        effectiveOn: '2026-01-01',
        amountMinor: 1,
        currency: 'USD'
      })
    ).toThrow('不能早于今天')
  })
  it('freezes rates and payment dates, accepts actual bank currency and guards stale edits', () => {
    repo.save(input)
    const bill = repo.ledger.bills()[0],
      paid = pay(bill.id)
    repo.saveExchangeRates({ ...rates, rates: { ...rates.rates, CNY: 99 } })
    expect(actualTotals(repo.ledger.bills(), 'CNY', '2026-01-01', '2026-01-31').total).toBe(14000)
    const edited = repo.ledger.updateBill(
      {
        id: bill.id,
        expectedUpdatedAt: paid.updatedAt,
        status: 'paid',
        payment: { amountMinor: 14600, currency: 'CNY', paidOn: '2026-01-30' }
      },
      repo.exchangeRates()
    )
    expect(edited.rates).toEqual(rates)
    expect(actualTotals([edited], 'USD', '2026-01-01', '2026-01-31').total).toBe(2086)
    expect(() =>
      repo.ledger.updateBill(
        { id: bill.id, expectedUpdatedAt: paid.updatedAt, status: 'pending' },
        null
      )
    ).toThrow('账单已发生变化')
    expect(() =>
      repo.ledger.updateBill(
        {
          id: bill.id,
          expectedUpdatedAt: edited.updatedAt,
          status: 'paid',
          payment: { amountMinor: 1, currency: 'USD', paidOn: '2027-01-01' }
        },
        rates
      )
    ).toThrow('不能晚于今天')
  })
  it('marks missing conversions without publishing a partial total and fills absent snapshots explicitly', () => {
    const s = repo.save(input),
      b = repo.ledger.bills()[0]
    const paid = repo.ledger.updateBill(
      {
        id: b.id,
        expectedUpdatedAt: b.updatedAt,
        status: 'paid',
        payment: { amountMinor: 2000, currency: 'USD', paidOn: '2026-01-31' }
      },
      null
    )
    expect(actualTotals([paid], 'CNY', '2026-01-01', '2026-01-31')).toMatchObject({
      total: null,
      missing: 1,
      count: 1
    })
    const fixed = repo.ledger.updateBill(
      { id: b.id, expectedUpdatedAt: paid.updatedAt, status: 'paid', payment: paid.payment! },
      rates
    )
    expect(actualTotals([fixed], 'CNY', '2026-01-01', '2026-01-31').total).toBe(14000)
    expect(() =>
      repo.ledger.addBill({ subscriptionId: s.id, due: b.due, payment: paid.payment! }, rates)
    ).toThrow('已有账单')
  })
  it('skips and reverses without duplicating calendar entries or changing future periods', () => {
    const s = repo.save(input),
      b = repo.ledger.bills()[0]
    const skipped = repo.ledger.updateBill(
      { id: b.id, expectedUpdatedAt: b.updatedAt, status: 'skipped' },
      null
    )
    const calendar = calendarBills(
      repo.list(),
      repo.ledger.bills(),
      repo.ledger.prices(),
      '2026-01-01',
      '2026-01-31',
      'USD'
    )
    expect(calendar).toHaveLength(1)
    expect(calendar[0].status).toBe('skipped')
    expect(
      totals(repo.list(), 'USD', '2026-01-31', rates, repo.ledger.prices(), repo.ledger.bills())
        .upcoming
    ).toBe(2000)
    const pending = repo.ledger.updateBill(
      { id: b.id, expectedUpdatedAt: skipped.updatedAt, status: 'pending' },
      null
    )
    expect(pending.payment).toBeNull()
    expect(repo.ledger.bills()).toHaveLength(1)
    expect(s.id).toBe(pending.subscriptionId)
  })
  it('supports manual historic records, preserves zero payments and months without records', () => {
    const s = repo.save({ ...input, autoRenew: false })
    repo.ledger.addBill(
      {
        subscriptionId: s.id,
        due: '2025-12-31',
        payment: { amountMinor: 0, currency: 'CNY', paidOn: '2026-01-01' }
      },
      null
    )
    expect(actualTotals(repo.ledger.bills(), 'USD', '2025-12-01', '2025-12-31').count).toBe(0)
    const months = spendingMonths(repo.ledger.bills(), 'USD', '2026-01-31')
    expect(months.at(-1)).toMatchObject({ count: 1, total: 0 })
    expect(months[0].count).toBe(0)
  })
  it('roundtrips complete ledgers and rejects broken backup relationships atomically', () => {
    const s = repo.save(input)
    pay(repo.ledger.bills()[0].id)
    const backup = repo.export()
    if (backup.version !== 4) throw new Error('Expected version 3')
    const original = repo.ledger.bills()
    repo.save({ ...input, amountMinor: 9000 }, s.id)
    repo.import(backup)
    expect(repo.ledger.bills()).toEqual(original)
    expect(repo.list()[0].amountMinor).toBe(2000)
    expect(() =>
      repo.import({
        ...backup,
        bills: [{ ...backup.bills[0], subscriptionId: '00000000-0000-4000-8000-000000000000' }]
      })
    ).toThrow()
    expect(() => repo.import({ ...backup, tracking: [] })).toThrow()
    expect(repo.ledger.bills()).toEqual(original)
    const legacy = {
      format: 'xuding',
      version: 1,
      exportedAt: backup.exportedAt,
      subscriptions: backup.subscriptions
    }
    repo.import(legacy)
    expect(repo.ledger.bills()).toEqual(original)
  })
  it('refuses imported record IDs that belong to an unrelated subscription', () => {
    const a = repo.save(input),
      b = repo.save({ ...input, name: '另一项' })
    const source = repo.export()
    if (source.version !== 4) throw new Error('Expected version 3')
    const billA = source.bills.find((r) => r.subscriptionId === a.id)!,
      billB = source.bills.find((r) => r.subscriptionId === b.id)!
    const partial = {
      ...source,
      subscriptions: source.subscriptions.filter((s) => s.id === a.id),
      bills: [{ ...billA, id: billB.id }],
      prices: source.prices.filter((p) => p.subscriptionId === a.id),
      tracking: source.tracking.filter((t) => t.subscriptionId === a.id),
      changes: source.changes
        .filter((c) => c.subscriptionId === a.id)
        .map((c) => ({ ...c, billId: c.billId ? billB.id : undefined }))
    }
    expect(() => repo.import(partial)).toThrow('记录 ID 与其他订阅冲突')
    expect(repo.ledger.bills()).toEqual(source.bills)
    expect(repo.list()).toEqual(source.subscriptions)
  })
})
