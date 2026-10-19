import type { Bill, Currency, Subscription } from './model'
import { categories } from './model'
import type { BillRecord, Price } from './ledger-model'
import { forecast } from './billing'
import { convertMinor } from './exchange'

export const billStatus = { pending: '待确认', paid: '已支付', skipped: '已跳过' } as const
export function actualTotals(bills: BillRecord[], currency: Currency, start: string, end: string) {
  const paid = bills.filter(
    (b) => b.status === 'paid' && b.payment && b.payment.paidOn >= start && b.payment.paidOn <= end
  )
  const amount = (b: BillRecord) =>
    convertMinor(b.payment!.amountMinor, b.payment!.currency, currency, b.rates)
  const sum = (items: BillRecord[]) => {
    const values = items.map(amount)
    return values.some((v) => v === null)
      ? null
      : Math.round(values.reduce<number>((n, v) => n + v!, 0))
  }
  return {
    total: sum(paid),
    count: paid.length,
    missing: paid.filter((b) => amount(b) === null).length,
    categories: categories.map((category) => ({
      category,
      amount: sum(paid.filter((b) => b.category === category))
    }))
  }
}
export function spendingMonths(bills: BillRecord[], currency: Currency, today: string) {
  const [year, month] = today.split('-').map(Number)
  return Array.from({ length: 6 }, (_, i) => {
    const date = new Date(Date.UTC(year, month - 6 + i, 1)),
      key = date.toISOString().slice(0, 7)
    return { month: key, ...actualTotals(bills, currency, key + '-01', key + '-31') }
  })
}
export function calendarBills(
  subscriptions: Subscription[],
  records: BillRecord[],
  prices: Price[],
  start: string,
  end: string,
  currency: Currency
): Bill[] {
  const projected = forecast(subscriptions, start, end, undefined, prices).filter(
    (b) =>
      !records.some((r) => r.subscriptionId === b.subscription.id && r.due === b.due && !r.manual)
  )
  const stored: Bill[] = records
    .filter((r) => r.due >= start && r.due <= end)
    .flatMap((r) => {
      const subscription = subscriptions.find((s) => s.id === r.subscriptionId)
      return subscription
        ? [
            {
              subscription,
              due: r.due,
              amountMinor: r.payment?.amountMinor ?? r.amountMinor,
              currency: r.payment?.currency ?? r.currency,
              status: r.status,
              recordId: r.id
            }
          ]
        : []
    })
  return [...projected, ...stored]
    .filter((b) => b.currency === currency)
    .sort(
      (a, b) =>
        a.due.localeCompare(b.due) ||
        a.subscription.name.localeCompare(b.subscription.name, 'zh-CN')
    )
}
