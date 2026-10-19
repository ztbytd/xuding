import { describe, expect, it } from 'vitest'
import { accessLabel, attentionItems, reminderCandidates } from '../src/shared/attention'
import { subscription } from './fixtures'
import { nextBills } from '../src/shared/billing'
import { settingsSchema, subscriptionInputSchema } from '../src/shared/model'

describe('entitlements and reminders', () => {
  it('keeps remaining access separate from renewal and does not guess missing dates', () => {
    const item = subscription({ autoRenew: false, accessEndsOn: '2026-11-30' })
    expect(accessLabel(item, '2026-10-19')).toBe('权益剩余 42 天')
    expect(nextBills(item, '2026-10-19')).toEqual([])
    expect(accessLabel(subscription({ autoRenew: false }), '2026-10-19')).toBe('到期日未记录')
    expect(accessLabel(item, '2026-11-30')).toBe('权益今天到期')
    expect(accessLabel(item, '2026-12-01')).toBe('权益已到期 1 天')
  })
  it('shows upcoming trials and expiring or expired disabled renewals without archiving', () => {
    const records = [
      subscription({ autoRenew: false, accessEndsOn: '2026-10-18' }),
      subscription({ id: 'trial', status: 'trial', anchorDate: '2026-10-22' }),
      subscription({
        id: 'archived',
        status: 'archived',
        autoRenew: false,
        accessEndsOn: '2026-10-19'
      }),
      subscription({ id: 'far', autoRenew: false, accessEndsOn: '2026-12-01' })
    ]
    expect(attentionItems(records, '2026-10-19').map((item) => item.subscription.id)).toEqual([
      records[0].id,
      'trial'
    ])
    expect(records[0].status).toBe('active')
  })
  it('deduplicates by subscription and billing or access period and catches up recent expiries', () => {
    const renew = subscription({ anchorDate: '2026-10-20' })
    const access = subscription({ id: 'access', autoRenew: false, accessEndsOn: '2026-10-20' })
    const candidates = reminderCandidates([renew, access], '2026-10-19')
    expect(candidates.map((item) => item.key)).toEqual([
      `${renew.id}:2026-10-20`,
      'access:access:2026-10-20'
    ])
    expect(reminderCandidates([access], '2026-10-21')[0].key).toBe(candidates[1].key)
    expect(reminderCandidates([access], '2026-10-28')).toEqual([])
    expect(
      reminderCandidates(
        [subscription({ status: 'trial', anchorDate: '2026-10-20' })],
        '2026-10-19'
      )[0].title
    ).toContain('试用结束提醒')
  })
  it('loads legacy preferences and records with defaults and rejects invalid entitlement dates', () => {
    expect(settingsSchema.parse({ notificationsEnabled: true })).toMatchObject({
      notificationsEnabled: true,
      closeBehavior: 'ask',
      autoBackupEnabled: true,
      backupRetentionDays: 14,
      launchAtLogin: false
    })
    const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = subscription()
    expect(subscriptionInputSchema.parse(input).accessEndsOn).toBeUndefined()
    expect(
      subscriptionInputSchema.safeParse({ ...input, accessEndsOn: '2026-02-30' }).success
    ).toBe(false)
  })
})
