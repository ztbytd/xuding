import { z } from 'zod'
import { dateSchema } from './model'
import type { Currency } from './model'

const rate = z.number().positive().finite().max(1_000_000)
export const exchangeRatesSchema = z
  .object({
    base: z.literal('EUR'),
    date: dateSchema,
    fetchedAt: z.string().datetime(),
    rates: z.object({ EUR: z.literal(1), CNY: rate, USD: rate, HKD: rate }).strict()
  })
  .strict()
export type ExchangeRates = z.infer<typeof exchangeRatesSchema>
export type ExchangeResult = { table: ExchangeRates | null; error: string | null }

// Keep fractions until the final aggregate; every supported currency uses two minor digits.
export function convertMinor(
  amount: number,
  from: Currency,
  to: Currency,
  table: ExchangeRates | null
): number | null {
  if (from === to || amount === 0) return amount
  if (!table) return null
  return (amount / table.rates[from]) * table.rates[to]
}
