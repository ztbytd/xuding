import { z } from 'zod'
import { categories, currencies, isDate } from './primitives'

export const monthSchema = z
  .string()
  .refine((v) => /^\d{4}-\d{2}$/.test(v) && isDate(v + '-01'), '月份无效')
const amount = z.number().int().min(0).max(999999999)
export const budgetInputSchema = z
  .object({
    month: monthSchema,
    enabled: z.boolean(),
    currency: z.enum(currencies),
    amountMinor: amount.positive(),
    threshold: z.number().int().min(1).max(99),
    allocations: z
      .array(z.object({ category: z.enum(categories), amountMinor: amount }).strict())
      .max(categories.length)
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.allocations.map((a) => a.category)).size !== v.allocations.length)
      ctx.addIssue({ code: 'custom', message: '分类预算不能重复' })
    if (v.allocations.reduce((n, a) => n + a.amountMinor, 0) > v.amountMinor)
      ctx.addIssue({ code: 'custom', message: '分类预算合计不能超过总预算' })
  })
export const budgetSchema = budgetInputSchema.safeExtend({ updatedAt: z.string().datetime() })
export type BudgetInput = z.infer<typeof budgetInputSchema>
export type Budget = z.infer<typeof budgetSchema>
export const budgetReminderSchema = z
  .object({ key: z.string().max(300), sentAt: z.string().datetime() })
  .strict()
export type BudgetReminder = z.infer<typeof budgetReminderSchema>
export const importBatchSchema = z
  .object({
    id: z.string().uuid(),
    source: z.string().max(255),
    kind: z.enum(['subscriptions', 'bills']),
    createdAt: z.string().datetime(),
    added: z.number().int().min(0),
    updated: z.number().int().min(0),
    skipped: z.number().int().min(0),
    safetyBackup: z.string().max(120)
  })
  .strict()
export type ImportBatch = z.infer<typeof importBatchSchema>
