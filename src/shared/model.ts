import { z } from 'zod'
import type { ExchangeRates, ExchangeResult } from './exchange'

import { currencies, dateSchema } from './primitives'
export { currencies, dateSchema, isDate } from './primitives'
export type { Currency } from './primitives'
import type { Currency } from './primitives'
import { billRecordSchema, priceSchema, ledgerChangeSchema, trackingSchema } from './ledger-model'
import type {
  BillRecord,
  BillInput,
  BillUpdate,
  Price,
  PriceInput,
  LedgerChange
} from './ledger-model'
import { categories } from './primitives'
export { categories } from './primitives'
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
export type Bill = {
  subscription: Subscription
  due: string
  amountMinor: number
  currency: Currency
  status?: BillRecord['status']
  recordId?: string
}
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
const backupBase = z.object({
  format: z.literal('xuding'),
  exportedAt: z.string().datetime(),
  subscriptions: z.array(subscriptionSchema).max(10000)
})
const legacyBackupSchema = backupBase.extend({ version: z.literal(1) }).strict()
const currentBackupSchema = backupBase
  .extend({
    version: z.literal(2),
    bills: z.array(billRecordSchema).max(100000),
    prices: z.array(priceSchema).max(100000),
    changes: z.array(ledgerChangeSchema).max(500000),
    tracking: z.array(trackingSchema).max(10000)
  })
  .strict()
export const backupSchema = z
  .discriminatedUnion('version', [legacyBackupSchema, currentBackupSchema])
  .superRefine((value, ctx) => {
    const ids = new Set(value.subscriptions.map((s) => s.id))
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (ids.size !== value.subscriptions.length) fail('备份中包含重复 ID')
    if (value.version === 1) return
    for (const rows of [value.bills, value.prices, value.changes]) {
      if (new Set(rows.map((r) => r.id)).size !== rows.length) fail('备份中包含重复记录')
      if (rows.some((r) => !ids.has(r.subscriptionId))) fail('账单或价格缺少所属订阅')
    }
    if (
      new Set(value.bills.filter((b) => !b.manual).map((b) => b.subscriptionId + ':' + b.due))
        .size !== value.bills.filter((b) => !b.manual).length
    )
      fail('备份中包含重复周期账单')
    if (
      new Set(value.prices.map((p) => p.subscriptionId + ':' + p.effectiveOn)).size !==
      value.prices.length
    )
      fail('价格生效日期重复')
    if (
      new Set(value.tracking.map((t) => t.subscriptionId)).size !== ids.size ||
      value.tracking.length !== ids.size ||
      value.tracking.some((t) => !ids.has(t.subscriptionId))
    )
      fail('账单跟踪记录不完整')
    if (
      value.subscriptions.some(
        (s) =>
          !value.prices.some((p) => p.subscriptionId === s.id && p.effectiveOn === '1970-01-01')
      )
    )
      fail('缺少初始价格')
    const billOwners = new Map(value.bills.map((b) => [b.id, b.subscriptionId]))
    if (value.changes.some((c) => c.billId && billOwners.get(c.billId) !== c.subscriptionId))
      fail('变更记录缺少所属账单')
  })
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
  bills: number
  prices: number
  legacy: boolean
}
export type DesktopAction = { sequence: number } & (
  { page: 'new' } | { page: 'detail'; id: string }
)
export type Snapshot = {
  subscriptions: Subscription[]
  bills: BillRecord[]
  prices: Price[]
  changes: LedgerChange[]
  settings: Settings
  version: string
  exchangeRates: ExchangeRates | null
  backupStatus: BackupStatus
  startupSupported: boolean
}

export interface DesktopApi {
  load(): Promise<Result<Snapshot>>
  save(input: SubscriptionInput, id?: string): Promise<Result<Subscription>>
  updateBill(input: BillUpdate): Promise<Result<BillRecord>>
  addBill(input: BillInput): Promise<Result<BillRecord>>
  changePrice(input: PriceInput): Promise<Result<void>>
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
