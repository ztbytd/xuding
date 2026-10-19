import type { Subscription } from './model'
import { daysBetween, formatMoney, nextBills } from './billing'

export function accessLabel(s: Subscription, today: string): string {
  if (!s.accessEndsOn) return '到期日未记录'
  const days = daysBetween(today, s.accessEndsOn)
  return days < 0 ? `权益已到期 ${-days} 天` : days === 0 ? '权益今天到期' : `权益剩余 ${days} 天`
}
export function attentionItems(subscriptions: Subscription[], today: string) {
  return subscriptions
    .filter((s) => s.status !== 'archived')
    .flatMap((s) => {
      if (!s.autoRenew && s.accessEndsOn && daysBetween(today, s.accessEndsOn) <= 7)
        return [{ subscription: s, date: s.accessEndsOn, label: accessLabel(s, today) }]
      if (
        s.autoRenew &&
        s.status === 'trial' &&
        daysBetween(today, s.anchorDate) >= 0 &&
        daysBetween(today, s.anchorDate) <= 7
      )
        return [
          {
            subscription: s,
            date: s.anchorDate,
            label: `试用${s.anchorDate === today ? '今天结束' : `${daysBetween(today, s.anchorDate)} 天后结束`}`
          }
        ]
      return []
    })
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.subscription.name.localeCompare(b.subscription.name, 'zh-CN')
    )
}
export function reminderCandidates(subscriptions: Subscription[], today: string) {
  return subscriptions
    .filter((s) => s.status !== 'archived')
    .flatMap((s) => {
      if (!s.autoRenew) {
        if (!s.accessEndsOn) return []
        const days = daysBetween(today, s.accessEndsOn)
        if (days > s.reminderDays || days < -7) return []
        return [
          {
            id: s.id,
            key: `${s.id}:access:${s.accessEndsOn}`,
            title: `${s.name} · 权益到期提醒`,
            body: accessLabel(s, today) + '，可查看详情或归档。'
          }
        ]
      }
      const bill = nextBills(s, today, 1)[0]
      if (!bill || daysBetween(today, bill.due) > s.reminderDays) return []
      const days = daysBetween(today, bill.due)
      return [
        {
          id: s.id,
          key: `${s.id}:${bill.due}`,
          title: `${s.name} · ${s.status === 'trial' && bill.due === s.anchorDate ? '试用结束提醒' : '续费提醒'}`,
          body: `${days === 0 ? '今天' : `${days} 天后`}预计扣款 ${formatMoney(bill.amountMinor, s.currency)}${s.status === 'trial' && bill.due === s.anchorDate ? '（试用结束）' : ''}`
        }
      ]
    })
}
