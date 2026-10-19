import type { Snapshot, Currency, Subscription } from './model'
import { monthlyMinor, isRenewing, localDate } from './billing'
import { priceAt } from './ledger-model'
import { convertMinor } from './exchange'
import { shiftMonth, monthEnd } from './analytics'
import { actualTotals } from './ledger'

export function spendingChanges(snapshot: Snapshot, currency: Currency, today: string) {
  const calendarDate = (timestamp: string) => localDate(new Date(timestamp))
  const month = today.slice(0, 7),
    previousMonth = shiftMonth(month, -1),
    baseline = monthEnd(previousMonth),
    rates =
      [...(snapshot.exchangeRates ? [snapshot.exchangeRates] : []), ...(snapshot.rateHistory ?? [])]
        .filter((r) => r.date <= today)
        .sort((a, b) => b.date.localeCompare(a.date))[0] ?? null
  const rows: { id: string; name: string; kind: string; amount: number }[] = [],
    unknown: string[] = []
  const previousRates = [...(snapshot.rateHistory ?? [])]
    .filter((r) => r.date <= baseline)
    .sort((a, b) => b.date.localeCompare(a.date))[0]
  let exchange = 0,
    exchangeAvailable = !!previousRates
  for (const latest of snapshot.subscriptions) {
    if (calendarDate(latest.createdAt) > today) continue
    const current =
      (snapshot.histories ?? [])
        .filter((s) => s.id === latest.id && calendarDate(s.updatedAt) <= today)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
      (calendarDate(latest.updatedAt) <= today ? latest : undefined)
    if (!current) {
      unknown.push(latest.name)
      continue
    }
    const candidates = (snapshot.histories ?? [])
      .filter((s) => s.id === current.id && calendarDate(s.updatedAt) <= baseline)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const before =
      candidates[0] ?? (calendarDate(current.updatedAt) <= baseline ? current : undefined)
    const newly = calendarDate(current.createdAt) > baseline
    if (!before && !newly) {
      unknown.push(current.name)
      continue
    }
    const amount = (s: Subscription, date: string) => {
      const priced = { ...s, ...priceAt(s, date, snapshot.prices) }
      return isRenewing(s)
        ? convertMinor(monthlyMinor(priced), priced.currency, currency, rates)
        : 0
    }
    const old = before ? amount(before, baseline) : 0,
      now = amount(current, today)
    if (old === null || now === null) {
      unknown.push(current.name)
      continue
    }
    const delta = now - old
    if (Math.abs(delta) >= 0.005)
      rows.push({
        id: current.id,
        name: current.name,
        kind: newly
          ? '新增订阅'
          : before && isRenewing(before) && !isRenewing(current)
            ? '停止续费'
            : before && !isRenewing(before) && isRenewing(current)
              ? '恢复续费'
              : before && (before.cycle !== current.cycle || before.interval !== current.interval)
                ? '周期调整'
                : '价格变化',
        amount: delta
      })
    if (before && previousRates) {
      const priced = { ...before, ...priceAt(before, baseline, snapshot.prices) }
      const oldFx = isRenewing(before)
        ? convertMinor(monthlyMinor(priced), priced.currency, currency, previousRates)
        : 0
      if (oldFx === null) exchangeAvailable = false
      else exchange += old - oldFx
    }
  }
  rows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
  const actual = actualTotals(snapshot.bills, currency, month + '-01', monthEnd(month)),
    previous = actualTotals(snapshot.bills, currency, previousMonth + '-01', baseline)
  return {
    baseline,
    rows,
    unknown,
    exchange: exchangeAvailable ? exchange : null,
    delta: unknown.length ? null : rows.reduce((n, r) => n + r.amount, 0),
    actualDelta:
      actual.count && previous.count && actual.total !== null && previous.total !== null
        ? actual.total - previous.total
        : null
  }
}
