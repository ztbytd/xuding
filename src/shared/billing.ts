import type { Bill, Currency, Subscription } from './model'

export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function addDays(value: string, amount: number): string {
  const date = new Date(value + 'T00:00:00Z')
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}
export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000)
}
export function isRenewing(s: Subscription): boolean {
  return s.status !== 'archived' && s.autoRenew
}
function periodMonths(s: Subscription): number {
  return s.interval * (s.cycle === 'year' ? 12 : 1)
}

/** Compute every occurrence from the original anchor, never from a clamped previous month. */
export function occurrences(s: Subscription, start: string, end: string, limit = 1000): Bill[] {
  if (!isRenewing(s) || start > end || end < s.anchorDate) return []
  const [year, month, day] = s.anchorDate.split('-').map(Number)
  const [fromYear, fromMonth] = start.split('-').map(Number)
  const step = periodMonths(s)
  let index = Math.max(0, Math.floor(((fromYear - year) * 12 + fromMonth - month) / step))
  const bills: Bill[] = []
  for (; bills.length < limit; index++) {
    const first = new Date(Date.UTC(year, month - 1 + index * step, 1))
    const maxDay = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)
    ).getUTCDate()
    const due = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, maxDay))
    )
      .toISOString()
      .slice(0, 10)
    if (due > end) break
    if (due >= start) bills.push({ subscription: s, due, amountMinor: s.amountMinor })
  }
  return bills
}
export function nextBills(s: Subscription, start: string, count = 3): Bill[] {
  return occurrences(s, start, '2199-12-31', count)
}
export function forecast(
  subscriptions: Subscription[],
  start: string,
  end: string,
  currency?: Currency
): Bill[] {
  return subscriptions
    .filter((s) => !currency || s.currency === currency)
    .flatMap((s) => occurrences(s, start, end))
    .sort(
      (a, b) =>
        a.due.localeCompare(b.due) ||
        a.subscription.name.localeCompare(b.subscription.name, 'zh-CN')
    )
}
export function monthlyMinor(s: Subscription): number {
  return s.amountMinor / periodMonths(s)
}
export function totals(subscriptions: Subscription[], currency: Currency, today: string) {
  const selected = subscriptions.filter((s) => s.currency === currency && isRenewing(s))
  const monthly = selected.reduce((sum, s) => sum + monthlyMinor(s), 0)
  const bills = forecast(selected, today, addDays(today, 29))
  return {
    monthly: Math.round(monthly),
    annual: Math.round(monthly * 12),
    upcoming: bills.reduce((n, b) => n + b.amountMinor, 0),
    count: selected.length,
    bills
  }
}
export function formatMoney(minor: number, currency: Currency): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2
  }).format(minor / 100)
}
export function formatDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return `${y}年${m}月${d}日`
}
export function cycleLabel(s: Pick<Subscription, 'cycle' | 'interval'>): string {
  return `每${s.interval === 1 ? '' : s.interval}${s.cycle === 'month' ? '月' : '年'}`
}
export function parseAmount(value: string): number | null {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value.trim())) return null
  const [whole, fraction = ''] = value.trim().split('.')
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return amount <= 999999999 ? amount : null
}
