import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { SubscriptionRepository } from '../src/main/database'
import { budgetInputSchema } from '../src/shared/analytics-model'
import { actualTotals, paymentMinor } from '../src/shared/ledger'
import {
  analysisMonths,
  budgetProgress,
  budgetReminderCandidates,
  monthlyProjection,
  spendingRanking
} from '../src/shared/analytics'
import type { BillRecord } from '../src/shared/ledger-model'
import { subscription } from './fixtures'

describe('budgets and spending analysis', () => {
  let repo: SubscriptionRepository, clock: Date
  const budget = {
    month: '2026-10',
    enabled: true,
    currency: 'CNY' as const,
    amountMinor: 50000,
    threshold: 80,
    allocations: [{ category: '效率工具' as const, amountMinor: 20000 }]
  }
  const record = (extra: Partial<BillRecord> = {}): BillRecord => ({
    id: randomUUID(),
    subscriptionId: '00000000-0000-4000-8000-000000000001',
    due: '2026-10-19',
    amountMinor: 1000,
    currency: 'CNY',
    category: '效率工具',
    status: 'pending',
    manual: false,
    payment: null,
    rates: null,
    createdAt: '2026-10-19T04:00:00Z',
    updatedAt: '2026-10-19T04:00:00Z',
    ...extra
  })
  beforeEach(() => {
    clock = new Date('2026-10-19T12:00:00+08:00')
    repo = new SubscriptionRepository(':memory:', () => clock)
  })
  afterEach(() => repo.close())
  it('rejects oversubscribed categories, duplicates and invalid months', () => {
    expect(budgetInputSchema.safeParse({ ...budget, amountMinor: 1 }).success).toBe(false)
    expect(
      budgetInputSchema.safeParse({
        ...budget,
        allocations: [...budget.allocations, ...budget.allocations]
      }).success
    ).toBe(false)
    expect(budgetInputSchema.safeParse({ ...budget, month: '2026-13' }).success).toBe(false)
    expect(() => repo.finance.save({ ...budget, month: '2026-11' })).toThrow('当前或历史月份')
  })
  it('materializes missed months without rewriting saved historical budgets', () => {
    repo.finance.save(budget)
    clock = new Date('2027-01-01T12:00:00+08:00')
    expect(repo.finance.ensureMonths()).toBe(true)
    expect(repo.finance.budgets().map((b) => b.month)).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01'
    ])
    expect(repo.finance.ensureMonths()).toBe(false)
    repo.finance.save({ ...budget, month: '2026-10', amountMinor: 90000 })
    expect(repo.finance.budgets().find((b) => b.month === '2027-01')!.amountMinor).toBe(50000)
    repo.finance.save({ ...budget, month: '2027-01', enabled: false })
    clock = new Date('2027-02-01T12:00:00+08:00')
    repo.finance.ensureMonths()
    expect(repo.finance.budgets().at(-1)!.enabled).toBe(false)
  })
  it('reconciles paid, pending and future without duplicates or old unpaid assumptions', () => {
    const s = subscription({
      id: '00000000-0000-4000-8000-000000000001',
      anchorDate: '2026-10-25',
      amountMinor: 2000,
      currency: 'CNY'
    })
    const records = [
      record({ due: '2026-09-19' }),
      record(),
      record({
        id: randomUUID(),
        subscriptionId: '00000000-0000-4000-8000-000000000002',
        due: '2026-09-01',
        status: 'paid',
        payment: { amountMinor: 500, currency: 'CNY', paidOn: '2026-10-01' }
      })
    ]
    const projection = monthlyProjection([s], records, [], 'CNY', '2026-10-19', null)
    expect(projection).toMatchObject({
      total: 3500,
      pendingAmount: 1000,
      futureAmount: 2000,
      olderPending: 1
    })
    const paidAhead = record({
      due: '2026-10-25',
      status: 'paid',
      payment: { amountMinor: 2000, currency: 'CNY', paidOn: '2026-10-19' }
    })
    expect(
      monthlyProjection([s], [...records, paidAhead], [], 'CNY', '2026-10-19', null).future
    ).toHaveLength(0)
    expect(
      monthlyProjection(
        [s],
        [record({ due: '2026-10-25', status: 'skipped' })],
        [],
        'CNY',
        '2026-10-19',
        null
      ).total
    ).toBe(0)
  })
  it('preserves manual historical conversions and exposes known amounts without partial totals', () => {
    const paid = record({
      status: 'paid',
      currency: 'USD',
      payment: { amountMinor: 10000, currency: 'USD', paidOn: '2026-10-19' },
      conversion: { source: 'manual', amountMinor: 72000, currency: 'CNY' }
    })
    expect(paymentMinor(paid, 'CNY')).toBe(72000)
    expect(paymentMinor(paid, 'USD')).toBe(10000)
    expect(paymentMinor(paid, 'EUR')).toBeNull()
    const totals = actualTotals(
      [
        paid,
        record({
          id: randomUUID(),
          status: 'paid',
          payment: { amountMinor: 1000, currency: 'EUR', paidOn: '2026-10-19' }
        })
      ],
      'CNY',
      '2026-10-01',
      '2026-10-31'
    )
    expect(totals).toMatchObject({ total: null, knownTotal: 72000, missing: 1, count: 2 })
    expect(budgetProgress({ ...budget, updatedAt: paid.updatedAt }, [paid]).ratio).toBe(1.44)
    expect(
      budgetReminderCandidates({ ...budget, updatedAt: paid.updatedAt }, [
        record({
          status: 'paid',
          payment: { amountMinor: 100, currency: 'USD', paidOn: '2026-10-19' }
        })
      ])
    ).toHaveLength(0)
  })
  it('includes archived paid history and distinguishes missing months from recorded zero', () => {
    const s = subscription({ status: 'archived' }),
      b = record({
        subscriptionId: s.id,
        status: 'paid',
        payment: { amountMinor: 0, currency: 'CNY', paidOn: '2026-10-19' }
      })
    const months = analysisMonths([b], 'CNY', '2026-10')
    expect(months).toHaveLength(12)
    expect(months.at(-1)).toMatchObject({ count: 1, total: 0 })
    expect(months[0].count).toBe(0)
    expect(spendingRanking([b], [s], 'CNY', '2026-10')[0]).toMatchObject({ count: 1, total: 0 })
  })
  it('backs up budget configuration and restores the whole ledger only when explicitly requested', () => {
    repo.finance.save(budget)
    const saved = repo.export()
    repo.finance.save({ ...budget, amountMinor: 90000 })
    const { id, createdAt, updatedAt, ...input } = subscription()
    repo.save(input)
    repo.import(saved)
    expect(repo.list()).toHaveLength(1)
    expect(repo.finance.budgets()[0].amountMinor).toBe(50000)
    repo.import(saved, true)
    expect(repo.list()).toHaveLength(0)
    if (saved.version !== 3) throw new Error('Wrong version')
    const { budgets, budgetReminders, importBatches, ...v2 } = saved
    expect(() => repo.import({ ...v2, version: 2 }, true)).toThrow('新版备份')
    repo.import({ ...v2, version: 2 })
    expect(repo.finance.budgets()).toHaveLength(1)
  })
  it('coalesces thresholds and uses a fresh revision after an explicit budget adjustment', () => {
    const saved = repo.finance.save({ ...budget, allocations: [] })
    const paid = record({
      status: 'paid',
      payment: { amountMinor: 60000, currency: 'CNY', paidOn: '2026-10-19' }
    })
    const candidates = budgetReminderCandidates(saved, [paid])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].keys).toHaveLength(2)
    for (const key of candidates[0].keys) repo.finance.markReminder(key)
    expect(candidates[0].keys.every((key) => repo.finance.hasReminder(key))).toBe(true)
    const adjusted = repo.finance.save({ ...budget, allocations: [], amountMinor: 70000 })
    expect(repo.finance.hasReminder(budgetReminderCandidates(adjusted, [paid])[0].key)).toBe(false)
  })
})
