import { describe, expect, it, vi } from 'vitest'
import { ExchangeService, parseExchangeResponse, EXCHANGE_URL } from '../src/main/exchange'
import { convertMinor } from '../src/shared/exchange'
import { totals } from '../src/shared/billing'
import { SubscriptionRepository } from '../src/main/database'
import { subscription } from './fixtures'

const now = new Date('2026-10-19T10:00:00Z')
const rows = [
  { date: '2026-10-16', base: 'EUR', quote: 'CNY', rate: 7.2 },
  { date: '2026-10-16', base: 'EUR', quote: 'USD', rate: 1 },
  { date: '2026-10-16', base: 'EUR', quote: 'HKD', rate: 7.8 }
]
const table = parseExchangeResponse(rows, now)
describe('currency conversion', () => {
  it('combines all currencies, rounds only final totals, and leaves originals untouched', () => {
    const items = [
      subscription({ amountMinor: 10000, currency: 'USD', anchorDate: '2026-10-19' }),
      subscription({ amountMinor: 3000, anchorDate: '2026-10-19', category: '生活服务' })
    ]
    expect(totals(items, 'CNY', '2026-10-19', table)).toMatchObject({
      monthly: 75000,
      annual: 900000,
      upcoming: 75000,
      count: 2,
      missing: []
    })
    expect(totals(items, 'USD', '2026-10-19', table)).toMatchObject({
      monthly: 10417,
      annual: 125000,
      upcoming: 10417,
      count: 2
    })
    expect(totals(items, 'CNY', '2026-10-19', table).categories.filter((c) => c.amount)).toEqual([
      { category: '效率工具', amount: 72000 },
      { category: '生活服务', amount: 3000 }
    ])
    expect(items[0]).toMatchObject({ amountMinor: 10000, currency: 'USD' })
    expect(convertMinor(7800, 'HKD', 'CNY', table)).toBeCloseTo(7200)
    expect(convertMinor(100, 'EUR', 'USD', table)).toBe(100)
  })
  it('never presents an incomplete converted total and keeps all forecast rows', () => {
    const items = [subscription(), subscription({ currency: 'USD' })]
    expect(totals(items, 'CNY', '2026-10-19')).toMatchObject({
      monthly: null,
      annual: null,
      upcoming: null,
      count: 2,
      missing: ['USD']
    })
    expect(totals(items, 'CNY', '2026-10-19').bills).toHaveLength(2)
    expect(
      totals([subscription({ currency: 'USD', anchorDate: '2027-01-01' })], 'CNY', '2026-10-19')
    ).toMatchObject({ monthly: null, upcoming: 0 })
    expect(convertMinor(0, 'USD', 'CNY', null)).toBe(0)
    expect(convertMinor(123, 'CNY', 'CNY', null)).toBe(123)
    expect(
      totals(
        [subscription({ autoRenew: false, currency: 'USD' }), subscription({ status: 'archived' })],
        'CNY',
        '2026-10-19'
      )
    ).toMatchObject({ monthly: 0, count: 0, missing: [] })
  })
  it('rejects partial, duplicate, inconsistent, future and invalid reference rates', () => {
    for (const invalid of [
      rows.slice(0, 2),
      [rows[0], rows[0], rows[2]],
      rows.map((r) => ({ ...r, rate: 0 })),
      rows.map((r) => ({ ...r, rate: Infinity })),
      rows.map((r) => ({ ...r, date: '2026-11-01' })),
      [rows[0], rows[1], { ...rows[2], date: '2026-10-15' }]
    ]) {
      expect(() => parseExchangeResponse(invalid, now)).toThrow()
    }
  })
  it('caches validated rates, deduplicates requests, and retains them on refresh failure', async () => {
    const repo = new SubscriptionRepository(':memory:')
    let clock = now
    const request = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(rows))
    )
    const service = new ExchangeService(repo, request, () => clock)
    try {
      const [first, second] = await Promise.all([service.get(), service.get(true)])
      expect(first.table).toEqual(table)
      expect(second.table).toEqual(table)
      expect(request).toHaveBeenCalledTimes(1)
      expect(request.mock.calls[0][0]).toBe(EXCHANGE_URL)
      await service.get()
      expect(request).toHaveBeenCalledTimes(1)
      clock = new Date('2026-10-20T10:00:00Z')
      request.mockRejectedValue(new Error('offline'))
      expect(await service.get()).toMatchObject({
        table,
        error: '汇率更新失败，正在使用本地缓存。'
      })
      await service.get()
      expect(request).toHaveBeenCalledTimes(2)
      expect(repo.exchangeRates()).toEqual(table)
      expect(repo.export()).not.toHaveProperty('exchangeRates')
      request.mockResolvedValue(new Response(JSON.stringify(rows.slice(0, 2))))
      expect((await service.get(true)).table).toEqual(table)
      expect(repo.exchangeRates()).toEqual(table)
    } finally {
      repo.close()
    }
  })
  it('returns an explicit missing-cache error and allows manual retry', async () => {
    const repo = new SubscriptionRepository(':memory:')
    const request = vi.fn(async () => {
      throw new Error('offline')
    })
    const service = new ExchangeService(repo, request, () => now)
    try {
      expect(await service.get()).toEqual({
        table: null,
        error: '暂时无法获取汇率，请联网后重试。'
      })
      await service.get(true)
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      repo.close()
    }
  })
})
