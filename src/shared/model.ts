import { z } from 'zod'
import type { ExchangeRates, ExchangeResult } from './exchange'

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
    icon: z
      .string()
      .max(100_000)
      .regex(
        /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/,
        '图标须为有效的本地 PNG 图片'
      )
      .optional(),
    category: z.enum(categories),
    amountMinor: z.number().int().min(0).max(999999999),
    currency: z.enum(currencies),
    cycle: z.enum(['month', 'year']),
    interval: z.number().int().min(1).max(12),
    anchorDate: dateSchema,
    status: z.enum(['active', 'trial', 'archived']),
    autoRenew: z.boolean(),
    accessEndsOn: dateSchema.optional(),
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
export const settingsPatchSchema = z
  .object({
    notificationsEnabled: z.boolean().optional(),
    launchAtLogin: z.boolean().optional(),
    startInTray: z.boolean().optional(),
    closeBehavior: z.enum(['ask', 'tray', 'quit']).optional(),
    autoBackupEnabled: z.boolean().optional(),
    backupRetentionDays: z.number().int().min(1).max(90).optional()
  })
  .strict()
export const settingsSchema = z
  .object({
    notificationsEnabled: z.boolean().default(false),
    launchAtLogin: z.boolean().default(false),
    startInTray: z.boolean().default(false),
    closeBehavior: z.enum(['ask', 'tray', 'quit']).default('ask'),
    autoBackupEnabled: z.boolean().default(true),
    backupRetentionDays: z.number().int().min(1).max(90).default(14)
  })
  .strict()
export type Settings = z.infer<typeof settingsSchema>
export type SettingsPatch = z.infer<typeof settingsPatchSchema>
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
export type BackupStatus = {
  directory: string
  lastSuccess: string | null
  lastError: string | null
  pending: boolean
}
export type BackupEntry = {
  id: string
  createdAt: string
  count: number
  size: number
  kind: 'daily' | 'manual' | 'before-restore'
}
export type RestorePreview = {
  token: string
  source: string
  exportedAt: string
  count: number
  added: number
  overwritten: number
  retained: number
}
export type DesktopAction = { sequence: number } & (
  { page: 'new' } | { page: 'detail'; id: string }
)
export type Snapshot = {
  subscriptions: Subscription[]
  settings: Settings
  version: string
  exchangeRates: ExchangeRates | null
  backupStatus: BackupStatus
  startupSupported: boolean
}

export interface DesktopApi {
  load(): Promise<Result<Snapshot>>
  save(input: SubscriptionInput, id?: string): Promise<Result<Subscription>>
  archive(id: string): Promise<Result<void>>
  settings(input: SettingsPatch): Promise<Result<Settings>>
  exportBackup(): Promise<Result<boolean>>
  previewImport(): Promise<Result<RestorePreview | null>>
  previewBackup(id: string): Promise<Result<RestorePreview>>
  restoreBackup(token: string): Promise<Result<number>>
  backupStatus(): Promise<Result<BackupStatus>>
  backupNow(): Promise<Result<BackupStatus>>
  backupHistory(): Promise<Result<BackupEntry[]>>
  chooseBackupDirectory(): Promise<Result<BackupStatus>>
  onNavigate(listener: (action: DesktopAction) => void): () => void
  navigationReady(): Promise<Result<DesktopAction | null>>
  openWebsite(url: string): Promise<Result<void>>
  pickIcon(): Promise<Result<string | null>>
  exchangeRates(force?: boolean): Promise<Result<ExchangeResult>>
}
