import { z } from 'zod'
import { currencies, dateSchema, categories, isDate } from './primitives'
import { exchangeRatesSchema } from './exchange'

const amount = z.number().int().min(0).max(999999999)
export const priceInputSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    amountMinor: amount,
    currency: z.enum(currencies),
    effectiveOn: dateSchema
  })
  .strict()
export const priceSchema = priceInputSchema
  .extend({ id: z.string().uuid(), createdAt: z.string().datetime() })
  .strict()
export type Price = z.infer<typeof priceSchema>
export type PriceInput = z.infer<typeof priceInputSchema>
export const paymentSchema = z
  .object({ amountMinor: amount, currency: z.enum(currencies), paidOn: dateSchema })
  .strict()
export type Payment = z.infer<typeof paymentSchema>
export const billRecordSchema = z
  .object({
    id: z.string().uuid(),
    subscriptionId: z.string().uuid(),
    due: dateSchema,
    amountMinor: amount,
    currency: z.enum(currencies),
    category: z.enum(categories),
    status: z.enum(['pending', 'paid', 'skipped']),
    manual: z.boolean(),
    payment: paymentSchema.nullable(),
    rates: exchangeRatesSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict()
  .refine(
    (b) => (b.status === 'paid' ? b.payment !== null : b.payment === null && b.rates === null),
    '账单状态与支付信息不一致'
  )
export type BillRecord = z.infer<typeof billRecordSchema>
export const billInputSchema = z
  .object({ subscriptionId: z.string().uuid(), due: dateSchema, payment: paymentSchema })
  .strict()
export type BillInput = z.infer<typeof billInputSchema>
export const billUpdateSchema = z
  .object({
    id: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    status: z.enum(['pending', 'paid', 'skipped']),
    payment: paymentSchema.optional()
  })
  .strict()
  .refine(
    (v) => (v.status === 'paid' ? !!v.payment : v.payment === undefined),
    '请填写有效的支付信息'
  )
export type BillUpdate = z.infer<typeof billUpdateSchema>
export const ledgerChangeSchema = z
  .object({
    id: z.string().uuid(),
    subscriptionId: z.string().uuid(),
    billId: z.string().uuid().optional(),
    label: z.string().max(500),
    changedAt: z.string().datetime()
  })
  .strict()
export type LedgerChange = z.infer<typeof ledgerChangeSchema>
export const trackingSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    startedOn: dateSchema,
    through: z.string().refine((v) => isDate(v) || v === '1969-12-31', '账单跟踪日期无效')
  })
  .strict()
export type Tracking = z.infer<typeof trackingSchema>

export function priceAt<T extends { id: string; amountMinor: number; currency: Price['currency'] }>(
  subscription: T,
  date: string,
  prices: Price[]
) {
  const price = prices
    .filter((p) => p.subscriptionId === subscription.id && p.effectiveOn <= date)
    .sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn))[0]
  return {
    amountMinor: price?.amountMinor ?? subscription.amountMinor,
    currency: price?.currency ?? subscription.currency
  }
}
