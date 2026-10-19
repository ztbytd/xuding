import { describe, expect, it } from 'vitest'
import {
  addDays,
  forecast,
  nextBills,
  occurrences,
  parseAmount,
  totals
} from '../src/shared/billing'
import { subscriptionInputSchema } from '../src/shared/model'
import { subscription } from './fixtures'

describe('billing rules', () => {
  it('clamps short months but preserves the original 31st anchor', () => {
    expect(occurrences(subscription(), '2026-01-01', '2026-04-30').map((b) => b.due)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30'
    ])
  })
  it('restores leap day in leap years for annual billing', () => {
    expect(
      occurrences(
        subscription({ cycle: 'year', anchorDate: '2024-02-29' }),
        '2025-01-01',
        '2028-12-31'
      ).map((b) => b.due)
    ).toEqual(['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29'])
  })
  it('supports quarterly billing and anchors in the distant past', () => {
    expect(
      nextBills(subscription({ anchorDate: '2000-01-31', interval: 3 }), '2026-02-01').map(
        (b) => b.due
      )
    ).toEqual(['2026-04-30', '2026-07-31', '2026-10-31'])
  })
  it('does not charge a trial before the first paid date', () => {
    expect(
      forecast(
        [subscription({ status: 'trial', anchorDate: '2026-11-10' })],
        '2026-10-01',
        '2026-11-09'
      )
    ).toEqual([])
  })
  it('excludes archived and renewal-disabled subscriptions', () => {
    expect(nextBills(subscription({ status: 'archived' }), '2026-10-19')).toEqual([])
    expect(nextBills(subscription({ autoRenew: false }), '2026-10-19')).toEqual([])
  })
  it('keeps annual amortization separate from cash flow and currencies', () => {
    const data = [
      subscription({ cycle: 'year', anchorDate: '2026-10-22' }),
      subscription({ id: 'different', currency: 'USD', amountMinor: 99999 })
    ]
    expect(totals(data, 'CNY', '2026-10-19')).toMatchObject({
      monthly: 1000,
      annual: 12000,
      upcoming: 12000,
      count: 1
    })
  })
  it('includes exactly 30 calendar days including today', () => {
    const items = [
      subscription({ anchorDate: '2026-11-17', cycle: 'year' }),
      subscription({ id: 'different', anchorDate: '2026-11-18', cycle: 'year' })
    ]
    expect(totals(items, 'CNY', '2026-10-19').upcoming).toBe(12000)
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('parses decimal currency without floating point multiplication', () => {
    expect(parseAmount('19.99')).toBe(1999)
    expect(parseAmount('0.29')).toBe(29)
    expect(parseAmount('10.1')).toBe(1010)
    for (const bad of ['-1', '1e3', '1.001', 'Infinity', '', '10000000'])
      expect(parseAmount(bad)).toBeNull()
  })
  it('rejects invalid dates and executable URLs', () => {
    const { id, createdAt, updatedAt, ...input } = subscription()
    expect(subscriptionInputSchema.safeParse({ ...input, anchorDate: '2026-02-30' }).success).toBe(
      false
    )
    expect(
      subscriptionInputSchema.safeParse({ ...input, website: 'javascript:alert(1)' }).success
    ).toBe(false)
  })
})
