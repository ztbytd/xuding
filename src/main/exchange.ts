import { z } from 'zod'
import { dateSchema } from '../shared/model'
import { exchangeRatesSchema } from '../shared/exchange'
import type { ExchangeRates, ExchangeResult } from '../shared/exchange'
import { localDate } from '../shared/billing'

export const EXCHANGE_URL =
  'https://api.frankfurter.dev/v2/providers/ecb/rates?base=EUR&quotes=CNY,USD,HKD'
const responseSchema = z
  .array(
    z.object({
      date: dateSchema,
      base: z.literal('EUR'),
      quote: z.enum(['CNY', 'USD', 'HKD']),
      rate: z.number().positive().finite().max(1_000_000)
    })
  )
  .length(3)

export function parseExchangeResponse(raw: unknown, now: Date): ExchangeRates {
  const rows = responseSchema.parse(raw)
  if (
    new Set(rows.map((row) => row.quote)).size !== 3 ||
    new Set(rows.map((row) => row.date)).size !== 1 ||
    rows[0].date > localDate(now)
  )
    throw new Error('汇率数据不完整或日期不一致。')
  return exchangeRatesSchema.parse({
    base: 'EUR',
    date: rows[0].date,
    fetchedAt: now.toISOString(),
    rates: { EUR: 1, ...Object.fromEntries(rows.map((row) => [row.quote, row.rate])) }
  })
}

type Cache = {
  exchangeRates(): ExchangeRates | null
  saveExchangeRates(table: ExchangeRates): void
}
export class ExchangeService {
  private pending: Promise<ExchangeResult> | null = null
  private lastFailure: { time: number; error: string } | null = null
  constructor(
    private cache: Cache,
    private request: (url: string, init?: RequestInit) => Promise<Response>,
    private now = () => new Date()
  ) {}

  async get(force = false): Promise<ExchangeResult> {
    if (this.pending) return this.pending
    const cached = this.cache.exchangeRates()
    const now = this.now()
    if (!force && cached && localDate(new Date(cached.fetchedAt)) === localDate(now))
      return { table: cached, error: this.lastFailure?.error ?? null }
    if (!force && this.lastFailure && now.getTime() - this.lastFailure.time < 5 * 60_000)
      return { table: cached, error: this.lastFailure.error }
    this.pending = this.update(cached).finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async update(cached: ExchangeRates | null): Promise<ExchangeResult> {
    try {
      const response = await this.request(EXCHANGE_URL, {
        signal: AbortSignal.timeout(8000),
        redirect: 'error'
      })
      if (!response.ok) throw new Error('汇率服务暂不可用。')
      const text = await response.text()
      if (text.length > 20_000) throw new Error('汇率响应过大。')
      const table = parseExchangeResponse(JSON.parse(text), this.now())
      if (cached && table.date < cached.date) throw new Error('汇率日期早于已保存数据。')
      this.cache.saveExchangeRates(table)
      this.lastFailure = null
      return { table, error: null }
    } catch {
      const error = cached ? '汇率更新失败，正在使用本地缓存。' : '暂时无法获取汇率，请联网后重试。'
      this.lastFailure = { time: this.now().getTime(), error }
      return { table: cached, error }
    }
  }
}
