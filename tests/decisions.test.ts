import { afterEach, describe, expect, it } from 'vitest'
import { SubscriptionRepository } from '../src/main/database'
import { decisionInputSchema } from '../src/shared/decision-model'
import { decisionAttention, usageSummary } from '../src/shared/decisions'
import { spendingChanges } from '../src/shared/spending-changes'
import type { Snapshot } from '../src/shared/model'
let now = new Date('2026-10-20T04:00:00Z')
const repo = new SubscriptionRepository(':memory:', () => now)
const input = {
  name: '决策测试',
  category: '效率工具' as const,
  amountMinor: 2000,
  currency: 'CNY' as const,
  cycle: 'month' as const,
  interval: 1,
  anchorDate: '2026-10-22',
  status: 'active' as const,
  autoRenew: true,
  reminderDays: 3 as const,
  website: '',
  notes: ''
}
afterEach(() => {
  repo.import(
    {
      format: 'xuding',
      version: 4,
      exportedAt: now.toISOString(),
      subscriptions: [],
      bills: [],
      prices: [],
      changes: [],
      tracking: [],
      budgets: [],
      budgetReminders: [],
      importBatches: [],
      usage: [],
      decisions: [],
      histories: [],
      rateHistory: []
    },
    true
  )
})
describe('usage and renewal decisions', () => {
  it('deduplicates days, refuses future use and does not mark untracked subscriptions idle', () => {
    const s = repo.save(input),
      d = repo.decisions.update(decisionInputSchema.parse({ subscriptionId: s.id }))
    expect(decisionAttention([s], [d], [], '2026-10-20')).toHaveLength(0)
    repo.decisions.record(s.id, '2026-10-20')
    repo.decisions.record(s.id, '2026-10-20')
    expect(repo.decisions.usage()).toHaveLength(1)
    expect(usageSummary(repo.decisions.usage(), s.id, '2026-10-20')).toEqual({
      last: '2026-10-20',
      count: 1
    })
    expect(() => repo.decisions.record(s.id, '2026-10-21')).toThrow('未来')
    repo.decisions.record(s.id, '2026-09-01')
    repo.decisions.record(s.id, '2026-10-20', true)
    expect(decisionAttention([s], [d], repo.decisions.usage(), '2026-10-20')[0].label).toContain(
      '30 天'
    )
  })
  it('keeps forecasts for cancellation requests and stops renewal only on confirmation', () => {
    const s = repo.save(input),
      d = decisionInputSchema.parse({
        subscriptionId: s.id,
        decision: 'consider',
        cancellation: 'requested',
        requestedOn: '2026-10-20'
      })
    repo.decisions.update(d)
    expect(repo.list()[0].autoRenew).toBe(true)
    expect(decisionAttention(repo.list(), repo.decisions.list(), [], '2026-10-20')).toHaveLength(1)
    repo.decisions.update({
      ...d,
      cancellation: 'confirmed',
      confirmedOn: '2026-10-20',
      endsOn: '2026-10-21',
      autoArchive: true
    })
    expect(repo.list()[0]).toMatchObject({
      autoRenew: false,
      accessEndsOn: '2026-10-21',
      status: 'active'
    })
    now = new Date('2026-10-22T04:00:00Z')
    expect(repo.decisions.archiveDue()).toBe(1)
    expect(repo.list()[0].status).toBe('archived')
    now = new Date('2026-10-20T04:00:00Z')
  })
  it('roundtrips new records, accepts legacy v3 and leaves settings local', () => {
    const s = repo.save(input)
    repo.decisions.record(s.id, '2026-10-20')
    repo.decisions.update(decisionInputSchema.parse({ subscriptionId: s.id, reason: '保留理由' }))
    const backup = repo.export()
    expect(backup.version).toBe(4)
    repo.saveSettings({ notificationsEnabled: true })
    repo.import(backup, true)
    expect(repo.decisions.usage()).toHaveLength(1)
    expect(repo.decisions.list()[0].reason).toBe('保留理由')
    expect(repo.settings().notificationsEnabled).toBe(true)
    if (backup.version !== 4) throw new Error('version')
    const { usage, decisions, histories, rateHistory, ...v3 } = backup
    repo.import({ ...v3, version: 3 }, true)
    expect(repo.decisions.usage()).toHaveLength(0)
  })
  it('reports new monthly commitments without inventing prior state', () => {
    repo.save(input)
    const b = repo.export()
    if (b.version !== 4) throw new Error('version')
    const result = spendingChanges(
      { ...b, exchangeRates: null } as unknown as Snapshot,
      'CNY',
      '2026-10-20'
    )
    expect(result.rows[0]).toMatchObject({ kind: '新增订阅', amount: 2000 })
    expect(result.actualDelta).toBeNull()
  })
  it('attributes a subscription created after local midnight to the correct month', () => {
    const s = repo.save(input),
      time = new Date('2026-10-01T00:30:00').toISOString(),
      current = { ...s, createdAt: time, updatedAt: time }
    const b = repo.export()
    if (b.version !== 4) throw new Error('version')
    const snapshot = {
      ...b,
      subscriptions: [current],
      histories: [current],
      exchangeRates: null
    } as unknown as Snapshot
    expect(spendingChanges(snapshot, 'CNY', '2026-10-20').rows[0]).toMatchObject({
      kind: '新增订阅',
      amount: 2000
    })
  })
})
