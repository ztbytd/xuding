import type { BillRecord, Price } from './ledger-model'
import type { Budget } from './analytics-model'
import type { Currency, Subscription } from './model'
import type { ExchangeRates } from './exchange'
import { convertMinor } from './exchange'
import { actualTotals, paymentMinor } from './ledger'
import { addDays, forecast } from './billing'

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7)
}
export function monthEnd(month: string): string {
  return addDays(shiftMonth(month, 1) + '-01', -1)
}
export function monthlyProjection(
  subscriptions: Subscription[],
  records: BillRecord[],
  prices: Price[],
  currency: Currency,
  today: string,
  rates: ExchangeRates | null
) {
  const month = today.slice(0, 7),
    start = month + '-01',
    end = monthEnd(month)
  const actual = actualTotals(records, currency, start, end)
  const pending = records.filter((b) => b.status === 'pending' && b.due >= start && b.due <= end)
  const future = forecast(subscriptions, addDays(today, 1), end, undefined, prices).filter(
    (b) => !records.some((r) => r.subscriptionId === b.subscription.id && r.due === b.due)
  )
  const sum = (values: (number | null)[]) =>
    values.some((v) => v === null) ? null : Math.round(values.reduce<number>((n, v) => n + v!, 0))
  const pendingAmount = sum(
    pending.map((b) => convertMinor(b.amountMinor, b.currency, currency, rates))
  )
  const futureAmount = sum(
    future.map((b) => convertMinor(b.amountMinor, b.currency, currency, rates))
  )
  const total =
    actual.total === null || pendingAmount === null || futureAmount === null
      ? null
      : actual.total + pendingAmount + futureAmount
  const expectedValues = [
    ...pending.map((b) => convertMinor(b.amountMinor, b.currency, currency, rates)),
    ...future.map((b) => convertMinor(b.amountMinor, b.currency, currency, rates))
  ]
  return {
    knownTotal:
      actual.knownTotal + Math.round(expectedValues.reduce<number>((n, v) => n + (v ?? 0), 0)),
    missing: actual.missing + expectedValues.filter((v) => v === null).length,
    actual,
    pending,
    future,
    pendingAmount,
    futureAmount,
    total,
    olderPending: records.filter((b) => b.status === 'pending' && b.due < start).length
  }
}
export function budgetProgress(
  budget: Budget,
  records: BillRecord[],
  projection?: ReturnType<typeof monthlyProjection>
) {
  const actual = actualTotals(
    records,
    budget.currency,
    budget.month + '-01',
    monthEnd(budget.month)
  )
  const ratio = actual.total === null ? null : actual.total / budget.amountMinor
  return {
    actual,
    ratio,
    remaining: actual.total === null ? null : budget.amountMinor - actual.total,
    predicted: projection?.total ?? null,
    allocations: budget.allocations.map((a) => {
      const total = actual.categories.find((c) => c.category === a.category)!.amount
      return {
        ...a,
        total,
        ratio:
          total === null ? null : a.amountMinor ? total / a.amountMinor : total > 0 ? Infinity : 0
      }
    })
  }
}
export function analysisMonths(records: BillRecord[], currency: Currency, month: string) {
  return Array.from({ length: 12 }, (_, i) => {
    const value = shiftMonth(month, i - 11)
    return { month: value, ...actualTotals(records, currency, value + '-01', monthEnd(value)) }
  })
}
export function spendingRanking(
  records: BillRecord[],
  subscriptions: Subscription[],
  currency: Currency,
  month: string
) {
  const rows = records.filter((b) => b.status === 'paid' && b.payment?.paidOn.startsWith(month))
  return subscriptions
    .flatMap((s) => {
      const own = rows.filter((b) => b.subscriptionId === s.id)
      if (!own.length) return []
      const values = own.map((b) => paymentMinor(b, currency))
      return [
        {
          subscription: s,
          count: own.length,
          total: values.some((v) => v === null)
            ? null
            : Math.round(values.reduce<number>((n, v) => n + v!, 0))
        }
      ]
    })
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1))
}
export function budgetReminderCandidates(budget: Budget | undefined, records: BillRecord[]) {
  if (!budget?.enabled) return []
  const progress = budgetProgress(budget, records)
  const scopes = [
    { label: '总预算', ratio: progress.ratio },
    ...progress.allocations.map((a) => ({ label: a.category, ratio: a.ratio }))
  ]
  return scopes.flatMap((scope) => {
    if (scope.ratio === null || scope.ratio < budget.threshold / 100) return []
    const reached = [budget.threshold, 100].filter((t) => scope.ratio! >= t / 100),
      threshold = reached.at(-1)!
    return [
      {
        key: `${budget.month}:${budget.updatedAt}:${scope.label}:${threshold}`,
        keys: reached.map((t) => `${budget.month}:${budget.updatedAt}:${scope.label}:${t}`),
        title: threshold === 100 ? '预算已用尽' : '预算使用提醒',
        body: `${budget.month} ${scope.label}${Number.isFinite(scope.ratio) ? `已使用 ${Math.round(scope.ratio * 100)}%` : '已有支出，超出零额度'}，预算币种 ${budget.currency}。`
      }
    ]
  })
}
