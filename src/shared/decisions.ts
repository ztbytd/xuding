import type { Decision, Usage } from './decision-model'
import type { Subscription } from './model'
import { daysBetween, nextBills } from './billing'
import { attentionItems } from './attention'

export function usageSummary(records: Usage[], id: string, today: string) {
  const days = [
    ...new Set(records.filter((u) => u.subscriptionId === id && u.day <= today).map((u) => u.day))
  ].sort()
  return { last: days.at(-1) ?? null, count: days.filter((d) => daysBetween(d, today) < 30).length }
}
export function decisionAttention(
  subscriptions: Subscription[],
  decisions: Decision[],
  usage: Usage[],
  today: string
) {
  const items = new Map(
    attentionItems(subscriptions, today).map((v) => [v.subscription.id, { ...v, priority: 2 }])
  )
  for (const s of subscriptions.filter((s) => s.status !== 'archived')) {
    const d = decisions.find((d) => d.subscriptionId === s.id)
    if (!d) continue
    const reasons: string[] = []
    const next = nextBills(s, today, 1)[0]
    if (
      (d.decision === 'consider' || d.decision === 'end') &&
      next &&
      daysBetween(today, next.due) <= 14
    )
      reasons.push('即将续费，待决定')
    if (d.cancellation === 'requested') reasons.push('取消申请待确认')
    if (d.reviewOn && d.reviewOn <= today) reasons.push('到了评估日期')
    const last = usageSummary(usage, s.id, today).last
    if (last && daysBetween(last, today) >= d.idleDays) reasons.push(`${d.idleDays} 天未记录使用`)
    if (reasons.length) {
      const existing = items.get(s.id)
      items.set(s.id, {
        subscription: s,
        date: next?.due ?? d.reviewOn ?? today,
        label: [...reasons, ...(existing ? [existing.label] : [])].join(' · '),
        priority: 0
      })
    }
  }
  return [...items.values()].sort((a, b) => a.priority - b.priority || a.date.localeCompare(b.date))
}
