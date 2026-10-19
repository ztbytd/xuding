import type { Subscription } from '../src/shared/model'
export function subscription(changes: Partial<Subscription> = {}): Subscription {
  return {
    id: '8b172240-0bd6-431d-8a16-a241f5337201',
    name: '测试会员',
    category: '效率工具',
    amountMinor: 12000,
    currency: 'CNY',
    cycle: 'month',
    interval: 1,
    anchorDate: '2026-01-31',
    status: 'active',
    autoRenew: true,
    reminderDays: 3,
    website: '',
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...changes
  }
}
