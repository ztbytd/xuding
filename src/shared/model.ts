import { z } from 'zod'

export const currencies = ['CNY', 'USD', 'EUR', 'HKD'] as const
export const categories = [
  '效率工具',
  '影音娱乐',
  '云存储',
  '学习成长',
  '生活服务',
  '其他'
] as const
export type Currency = (typeof currencies)[number]

export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1970-01-01' || value > '2100-12-31')
    return false
  const date = new Date(value + 'T00:00:00Z')
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export const dateSchema = z.string().refine(isDate, '请输入有效日期（1970—2100 年）')
export const subscriptionInputSchema = z
  .object({
    name: z.string().trim().min(1, '请输入订阅名称').max(80),
    category: z.enum(categories),
    amountMinor: z.number().int().min(0).max(999999999),
    currency: z.enum(currencies),
    cycle: z.enum(['month', 'year']),
    interval: z.number().int().min(1).max(12),
    anchorDate: dateSchema,
    status: z.enum(['active', 'trial', 'archived']),
    autoRenew: z.boolean(),
    reminderDays: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(7), z.literal(14)]),
    website: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => {
        if (!value) return true
        try {
          return ['https:', 'http:'].includes(new URL(value).protocol)
        } catch {
          return false
        }
      }, '网址须以 https:// 或 http:// 开头'),
    notes: z.string().max(2000)
  })
  .strict()

export const subscriptionSchema = subscriptionInputSchema
  .extend({
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict()
export type SubscriptionInput = z.infer<typeof subscriptionInputSchema>
export type Subscription = z.infer<typeof subscriptionSchema>
export type Bill = { subscription: Subscription; due: string; amountMinor: number }
export const settingsSchema = z.object({ notificationsEnabled: z.boolean() }).strict()
export type Settings = z.infer<typeof settingsSchema>
export const backupSchema = z
  .object({
    format: z.literal('xuding'),
    version: z.literal(1),
    exportedAt: z.string().datetime(),
    subscriptions: z.array(subscriptionSchema).max(10000)
  })
  .strict()
  .refine(
    (value) => new Set(value.subscriptions.map((s) => s.id)).size === value.subscriptions.length,
    '备份中包含重复 ID'
  )
export type Backup = z.infer<typeof backupSchema>
export type Result<T> = { ok: true; data: T } | { ok: false; error: string }
export type Snapshot = { subscriptions: Subscription[]; settings: Settings; version: string }

export interface DesktopApi {
  load(): Promise<Result<Snapshot>>
  save(input: SubscriptionInput, id?: string): Promise<Result<Subscription>>
  archive(id: string): Promise<Result<void>>
  settings(input: Settings): Promise<Result<Settings>>
  exportBackup(): Promise<Result<boolean>>
  importBackup(): Promise<Result<number | null>>
  openWebsite(url: string): Promise<Result<void>>
}
