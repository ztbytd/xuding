import { z } from 'zod'
import { currencies, categories, dateSchema } from './primitives'
import type { Subscription, SubscriptionInput } from './model'
import type { BillRecord } from './ledger-model'

export const csvFields = [
  'subscriptionId',
  'name',
  'category',
  'amount',
  'currency',
  'cycle',
  'interval',
  'anchorDate',
  'status',
  'autoRenew',
  'accessEndsOn',
  'website',
  'notes',
  'effectiveOn',
  'billId',
  'due',
  'paymentAmount',
  'paymentCurrency',
  'paidOn',
  'convertedAmount',
  'convertedCurrency',
  'fxDate',
  'manual'
] as const
export type CsvField = (typeof csvFields)[number]
export type CsvKind = 'subscriptions' | 'bills'
export const fieldLabels: Record<CsvField, string> = {
  subscriptionId: '订阅 ID',
  name: '订阅名称',
  category: '分类',
  amount: '预计金额',
  currency: '订阅币种',
  cycle: '周期单位',
  interval: '周期间隔',
  anchorDate: '计费基准日',
  status: '状态',
  autoRenew: '自动续费',
  accessEndsOn: '权益到期日',
  website: '网址',
  notes: '备注',
  effectiveOn: '价格生效日期',
  billId: '账单 ID',
  due: '应扣日期',
  paymentAmount: '实际金额',
  paymentCurrency: '支付币种',
  paidOn: '支付日期',
  convertedAmount: '历史折算金额',
  convertedCurrency: '历史折算币种',
  fxDate: '汇率参考日期',
  manual: '手动补录'
}
export const subscriptionFields: CsvField[] = [
  'subscriptionId',
  'name',
  'amount',
  'currency',
  'cycle',
  'interval',
  'anchorDate',
  'category',
  'status',
  'autoRenew',
  'accessEndsOn',
  'website',
  'notes',
  'effectiveOn'
]
export const billFields: CsvField[] = [
  'billId',
  'subscriptionId',
  'name',
  'due',
  'amount',
  'currency',
  'status',
  'paymentAmount',
  'paymentCurrency',
  'paidOn',
  'category',
  'convertedAmount',
  'convertedCurrency',
  'fxDate',
  'manual'
]
export const csvOptionsSchema = z
  .object({
    fileToken: z.string().uuid(),
    kind: z.enum(['subscriptions', 'bills']),
    mapping: z.partialRecord(z.enum(csvFields), z.number().int().min(0).max(99)),
    dateOrder: z.enum(['YMD', 'DMY', 'MDY']),
    conversion: z.enum(['none', 'current']),
    defaults: z
      .object({
        currency: z.enum(currencies),
        category: z.enum(categories),
        cycle: z.enum(['month', 'year']),
        interval: z.number().int().min(1).max(12),
        anchorDate: dateSchema,
        autoRenew: z.boolean(),
        status: z.enum(['active', 'trial', 'archived'])
      })
      .strict(),
    priceEffectiveOn: dateSchema,
    decisions: z
      .array(
        z
          .object({
            row: z.number().int().min(2).max(10001),
            action: z.enum(['auto', 'skip', 'new', 'update']),
            subscriptionId: z.string().uuid().optional(),
            corrections: z.record(z.string().max(30), z.string().max(2048)).optional(),
            createSubscription: z.unknown().optional()
          })
          .strict()
      )
      .max(10000)
  })
  .strict()
export type CsvOptions = z.infer<typeof csvOptionsSchema>
export type CsvDecision = CsvOptions['decisions'][number]
export type CsvFile = {
  token: string
  name: string
  encoding: 'utf-8' | 'gb18030'
  headers: string[]
  rows: string[][]
}
export type CsvPreviewRow = {
  row: number
  status: 'new' | 'update' | 'duplicate' | 'error' | 'skipped'
  name: string
  summary: string
  message: string
  values: Partial<Record<CsvField, string>>
  matchedId?: string
  candidates?: { id: string; name: string }[]
}
export type CsvPreview = {
  token: string
  source: string
  kind: CsvKind
  rows: CsvPreviewRow[]
  added: number
  updated: number
  skipped: number
  errors: number
  revision: number
}
export type CsvOperation =
  | { kind: 'subscription'; item: Subscription; effectiveOn: string }
  | { kind: 'bill'; item: BillRecord; createSubscription?: SubscriptionInput & { id: string } }
export const csvExportSchema = z
  .object({
    kind: z.enum(['subscriptions', 'bills']),
    ids: z.array(z.string().uuid()).max(100000).optional(),
    currency: z.enum(currencies),
    template: z.boolean().optional()
  })
  .strict()
export type CsvExport = z.infer<typeof csvExportSchema>
