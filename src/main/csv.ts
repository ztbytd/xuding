import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import { csvOptionsSchema } from '../shared/csv-model'
import type {
  CsvFile,
  CsvOptions,
  CsvPreview,
  CsvPreviewRow,
  CsvOperation,
  CsvField
} from '../shared/csv-model'
import { parseCsv, csvDate } from '../shared/csv'
import { subscriptionInputSchema, subscriptionSchema } from '../shared/model'
import { billRecordSchema } from '../shared/ledger-model'
import type { Subscription } from '../shared/model'
import type { BillRecord } from '../shared/ledger-model'
import type { ExchangeRates } from '../shared/exchange'
import type { SubscriptionRepository } from './database'
import type { BackupService } from './backups'
import { localDate, parseAmount } from '../shared/billing'
import type { ImportBatch } from '../shared/analytics-model'

const uuid = z.string().uuid()
const clean = (value: string) => (/^'[\s=+@-]/.test(value) ? value.slice(1) : value)
function amount(value: string, label: string): number {
  const normalized = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(value)
    ? value.replaceAll(',', '')
    : value
  const result = parseAmount(normalized)
  if (result === null) throw new Error(`${label}须为非负金额，最多两位小数。`)
  return result
}
function bool(value: string, fallback: boolean) {
  if (!value) return fallback
  if (/^(true|1|yes|是|开启|已开启)$/i.test(value)) return true
  if (/^(false|0|no|否|关闭|已关闭)$/i.test(value)) return false
  throw new Error('自动续费 / 手动补录须为 true 或 false。')
}
function status(value: string, kind: 'subscriptions' | 'bills') {
  const map: Record<string, string> =
    kind === 'subscriptions'
      ? { 付费订阅: 'active', 付费: 'active', 试用: 'trial', 免费试用: 'trial', 已归档: 'archived' }
      : { 已支付: 'paid', 待确认: 'pending', 未支付: 'pending', 已跳过: 'skipped' }
  return map[value] ?? value
}
type Prepared = { preview: CsvPreview; operations: CsvOperation[]; expires: number }
export class CsvService {
  private file: { token: string; name: string; bytes: Buffer; expires: number } | null = null
  private decoded: CsvFile | null = null
  private prepared: Prepared | null = null
  clear(): void {
    this.file?.bytes.fill(0)
    this.file = null
    this.decoded = null
    this.prepared = null
  }
  constructor(
    private repo: SubscriptionRepository,
    private backups: BackupService,
    private now = () => new Date()
  ) {}
  async choose(path: string): Promise<CsvFile> {
    if ((await stat(path)).size > 10 * 1024 * 1024) throw new Error('CSV 文件不能超过 10 MB。')
    const bytes = await readFile(path)
    if (bytes.length > 10 * 1024 * 1024) throw new Error('CSV 文件不能超过 10 MB。')
    this.file = {
      token: randomUUID(),
      name: basename(path).slice(0, 255),
      bytes,
      expires: Date.now() + 30 * 60_000
    }
    this.prepared = null
    let encoding: 'utf-8' | 'gb18030' = 'utf-8'
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      encoding = 'gb18030'
    }
    return this.decode(this.file.token, encoding)
  }
  decode(token: string, encoding: 'utf-8' | 'gb18030'): CsvFile {
    if (!this.file || this.file.token !== token || this.file.expires < Date.now())
      throw new Error('文件已过期，请重新选择。')
    if (!['utf-8', 'gb18030'].includes(encoding)) throw new Error('文件编码无效。')
    let text: string
    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(this.file.bytes)
    } catch {
      throw new Error('无法按所选编码读取文件，请切换编码。')
    }
    const table = parseCsv(text)
    this.prepared = null
    this.decoded = { token, name: this.file.name, encoding, ...table }
    return this.decoded
  }
  preview(raw: CsvOptions, rates: ExchangeRates | null): CsvPreview {
    const options = csvOptionsSchema.parse(raw),
      file = this.decoded
    if (!file || file.token !== options.fileToken || !this.file || this.file.expires < Date.now())
      throw new Error('请重新选择 CSV 文件。')
    const mapped = Object.values(options.mapping)
    if (
      mapped.some((v) => v !== undefined && v >= file.headers.length) ||
      new Set(mapped).size !== mapped.length
    )
      throw new Error('字段映射包含无效或重复列。')
    const now = this.now().toISOString(),
      today = localDate(this.now()),
      subscriptions = this.repo.list(),
      bills = this.repo.ledger.bills()
    const operations: CsvOperation[] = [],
      rows: CsvPreviewRow[] = [],
      decisions = new Map(options.decisions.map((d) => [d.row, d]))
    if (decisions.size !== options.decisions.length) throw new Error('行处理选项重复。')
    const seenNames = new Set<string>(),
      seenBillKeys = new Set<string>(),
      seenPeriods = new Set<string>(),
      reserved = new Set<string>()
    const currentSubscriptions = [...subscriptions]
    const subscriptionById = new Map(subscriptions.map((s) => [s.id, s]))
    const names = new Map<string, Subscription[]>()
    for (const s of subscriptions) {
      const key = s.name.toLocaleLowerCase()
      names.set(key, [...(names.get(key) ?? []), s])
    }
    const remember = (s: Subscription) => {
      currentSubscriptions.push(s)
      subscriptionById.set(s.id, s)
      const key = s.name.toLocaleLowerCase()
      names.set(key, [...(names.get(key) ?? []), s])
    }
    const billById = new Map(bills.map((b) => [b.id, b]))
    const paymentKey = (id: string, due: string, status: string, payment: BillRecord['payment']) =>
      JSON.stringify([id, due, status, payment])
    const exactBills = new Map(
      bills.map((b) => [paymentKey(b.subscriptionId, b.due, b.status, b.payment), b])
    )
    const periods = new Map(
      bills.filter((b) => !b.manual).map((b) => [b.subscriptionId + ':' + b.due, b])
    )
    for (let i = 0; i < file.rows.length; i++) {
      const row = i + 2,
        decision = decisions.get(row),
        values: Partial<Record<CsvField, string>> = {}
      for (const [key, index] of Object.entries(options.mapping))
        if (index !== undefined) values[key as CsvField] = clean(file.rows[i][index] ?? '').trim()
      for (const [key, value] of Object.entries(decision?.corrections ?? {}))
        if (Object.hasOwn(fieldNames, key)) values[key as CsvField] = value.trim()
      const v = (key: CsvField) => values[key] ?? ''
      const result: CsvPreviewRow = {
        row,
        status: 'error',
        name: v('name'),
        summary: '',
        message: '',
        values
      }
      if (decision?.action === 'skip') {
        rows.push({ ...result, status: 'skipped', message: '已排除此行' })
        continue
      }
      try {
        if (options.kind === 'subscriptions') {
          const id = v('subscriptionId')
          if (id && !uuid.safeParse(id).success)
            throw new Error('订阅 ID 须为有效 UUID，或清空以新增。')
          const named = names.get(v('name').toLocaleLowerCase()) ?? []
          const previous = decision?.subscriptionId
            ? subscriptionById.get(decision.subscriptionId)
            : id
              ? subscriptionById.get(id)
              : named.length === 1
                ? named[0]
                : undefined
          result.candidates = named.map((s) => ({ id: s.id, name: s.name }))
          result.matchedId = previous?.id
          const cycle =
            (
              { 月: 'month', 年: 'year', monthly: 'month', yearly: 'year' } as Record<
                string,
                string
              >
            )[v('cycle').toLowerCase()] ??
            (v('cycle') || options.defaults.cycle)
          const input = subscriptionInputSchema.parse({
            name: v('name'),
            reminderDays: previous?.reminderDays ?? 3,
            amountMinor: amount(v('amount'), '订阅金额'),
            currency: v('currency').toUpperCase() || options.defaults.currency,
            category: v('category') || options.defaults.category,
            cycle,
            interval: v('interval') ? Number(v('interval')) : options.defaults.interval,
            anchorDate: v('anchorDate')
              ? csvDate(v('anchorDate'), options.dateOrder)
              : options.defaults.anchorDate,
            status: status(v('status') || options.defaults.status, 'subscriptions'),
            autoRenew: bool(v('autoRenew'), options.defaults.autoRenew),
            accessEndsOn: v('accessEndsOn')
              ? csvDate(v('accessEndsOn'), options.dateOrder)
              : undefined,
            website: v('website'),
            notes: v('notes')
          })
          if (input.status === 'archived') input.autoRenew = false
          result.name = input.name
          result.summary = `${input.currency} ${(input.amountMinor / 100).toFixed(2)} / ${input.interval}${input.cycle === 'month' ? '月' : '年'}`
          const nameKey = input.name.toLocaleLowerCase(),
            duplicate = !!previous || named.length > 0 || seenNames.has(nameKey)
          if (decision?.action === 'update' && !previous)
            throw new Error('请选择需要更新的已有订阅。')
          if (duplicate && (!decision || decision.action === 'auto')) {
            result.status = 'duplicate'
            result.message = '发现相同 ID 或名称，默认跳过；可明确选择更新或新增。'
            rows.push(result)
            continue
          }
          const update = decision?.action === 'update'
          const effectiveOn = v('effectiveOn')
            ? csvDate(v('effectiveOn'), options.dateOrder)
            : options.priceEffectiveOn
          if (update && effectiveOn < today) throw new Error('更新价格的生效日期不能早于今天。')
          const item = subscriptionSchema.parse({
            ...input,
            icon: update ? previous?.icon : undefined,
            id: update
              ? previous!.id
              : id && !currentSubscriptions.some((s) => s.id === id)
                ? id
                : randomUUID(),
            createdAt: update ? previous!.createdAt : now,
            updatedAt: now
          })
          const key = 'subscription:' + item.id
          if (reserved.has(key)) throw new Error('文件中多行更新同一订阅，请保留其中一行。')
          reserved.add(key)
          operations.push({
            kind: 'subscription',
            item,
            effectiveOn: update ? effectiveOn : '1970-01-01'
          })
          if (!update) remember(item)
          seenNames.add(nameKey)
          result.status = update ? 'update' : 'new'
          result.message = update
            ? `更新已有订阅，价格 ${effectiveOn} 生效`
            : '新增订阅，从导入当天跟踪'
        } else {
          const subscriptionId = decision?.subscriptionId || v('subscriptionId'),
            id = v('billId')
          if (id && !uuid.safeParse(id).success)
            throw new Error('账单 ID 须为有效 UUID，或清空以新增。')
          if (subscriptionId && !uuid.safeParse(subscriptionId).success)
            throw new Error('订阅 ID 无效，请在行设置中选择订阅。')
          const named = names.get(v('name').toLocaleLowerCase()) ?? []
          let subscription: Subscription | undefined = subscriptionId
            ? subscriptionById.get(subscriptionId)
            : named.length === 1
              ? named[0]
              : undefined
          result.candidates = named.map((s) => ({ id: s.id, name: s.name }))
          let create: Extract<CsvOperation, { kind: 'bill' }>['createSubscription']
          // New subscriptions are only created after an explicit per-row configuration.
          if (decision?.createSubscription) {
            const input = subscriptionInputSchema.parse(decision.createSubscription)
            if (names.has(input.name.toLocaleLowerCase()))
              throw new Error('该名称已有订阅，请关联已有记录。')
            const newId = randomUUID()
            create = { ...input, id: newId }
            subscription = subscriptionSchema.parse({
              ...input,
              id: newId,
              createdAt: now,
              updatedAt: now
            })
          }
          if (!subscription)
            throw new Error(
              named.length > 1
                ? '名称对应多个订阅，请选择具体订阅。'
                : '找不到订阅，请关联已有订阅或配置新订阅。'
            )
          result.name = subscription.name
          const due = csvDate(v('due'), options.dateOrder),
            state = status(v('status') || 'paid', 'bills')
          if (!['pending', 'paid', 'skipped'].includes(state))
            throw new Error('账单状态须为 paid、pending 或 skipped。')
          const payment =
            state === 'paid'
              ? {
                  amountMinor: amount(v('paymentAmount'), '实际金额'),
                  currency:
                    v('paymentCurrency').toUpperCase() ||
                    v('currency').toUpperCase() ||
                    options.defaults.currency,
                  paidOn: csvDate(v('paidOn'), options.dateOrder)
                }
              : null
          if (payment && payment.paidOn > today) throw new Error('实际支付日期不能晚于今天。')
          let conversion: BillRecord['conversion'] = payment
            ? { source: options.conversion === 'current' ? 'import-current' : 'import-none' }
            : undefined
          if (payment && (v('convertedAmount') || v('convertedCurrency'))) {
            conversion = {
              source: 'manual',
              amountMinor: amount(v('convertedAmount'), '历史折算金额'),
              currency: z
                .enum(['CNY', 'USD', 'EUR', 'HKD'])
                .parse(v('convertedCurrency').toUpperCase()),
              date: v('fxDate') ? csvDate(v('fxDate'), options.dateOrder) : undefined
            }
          }
          const exact = exactBills.get(
            paymentKey(subscription.id, due, state, payment as BillRecord['payment'])
          )
          const previous =
            (id ? billById.get(id) : undefined) ?? exact ?? periods.get(subscription.id + ':' + due)
          if (previous && previous.subscriptionId !== subscription.id)
            throw new Error('账单 ID 属于其他订阅，请核对关联。')
          const period = subscription.id + ':' + due,
            fingerprint = JSON.stringify([subscription.id, due, state, payment])
          result.matchedId = previous?.id
          result.summary = payment
            ? `${payment.currency} ${(payment.amountMinor / 100).toFixed(2)} · ${payment.paidOn}`
            : `${due} · ${state}`
          if (
            (previous || seenBillKeys.has(fingerprint) || seenPeriods.has(period)) &&
            (!decision || decision.action === 'auto')
          ) {
            result.status = 'duplicate'
            result.message = '发现已有或重复账单，默认跳过；更新需要明确选择。'
            rows.push(result)
            continue
          }
          if (decision?.action === 'update' && !previous)
            throw new Error('没有找到可更新账单，请保留账单 ID 或关联相同应扣日期。')
          const update = decision?.action === 'update'
          const item = billRecordSchema.parse({
            id: update ? previous!.id : id && !billById.has(id) ? id : randomUUID(),
            subscriptionId: subscription.id,
            due,
            amountMinor: v('amount')
              ? amount(v('amount'), '预计金额')
              : (previous?.amountMinor ?? subscription.amountMinor),
            currency: v('currency').toUpperCase() || previous?.currency || subscription.currency,
            category: v('category') || previous?.category || subscription.category,
            status: state,
            manual: update
              ? previous!.manual
              : decision?.action === 'new' && (!!previous || seenPeriods.has(period))
                ? true
                : v('manual')
                  ? bool(v('manual'), false)
                  : decision?.action === 'new' && (!!previous || seenPeriods.has(period)),
            payment,
            rates: payment && conversion?.source === 'import-current' ? rates : null,
            conversion,
            createdAt: update ? previous!.createdAt : now,
            updatedAt: new Date(
              Math.max(this.now().getTime(), update ? Date.parse(previous!.updatedAt) + 1 : 0)
            ).toISOString()
          })
          if (update && (previous!.due !== due || previous!.manual !== item.manual))
            throw new Error('更新账单时应扣日期需与已有记录一致；其他日期请新增。')
          const key = 'bill:' + item.id
          if (reserved.has(key)) throw new Error('文件中多行更新同一账单，请保留其中一行。')
          reserved.add(key)
          operations.push({ kind: 'bill', item, createSubscription: create })
          seenBillKeys.add(fingerprint)
          seenPeriods.add(period)
          if (create) remember(subscription)
          result.status = update ? 'update' : 'new'
          result.message = payment
            ? conversion?.source === 'manual'
              ? '使用提供的历史折算金额'
              : conversion?.source === 'import-current'
                ? rates
                  ? `使用导入时参考汇率 ${rates.date}`
                  : '缺少当前汇率，先保存原币账单'
                : '暂不折算，保留原币账单'
            : '保存账单状态'
        }
      } catch (error) {
        result.status = 'error'
        result.message =
          error instanceof z.ZodError
            ? error.issues.map((i) => i.message).join('；')
            : error instanceof Error
              ? error.message
              : '行数据无效'
      }
      rows.push(result)
    }
    const preview: CsvPreview = {
      token: randomUUID(),
      source: file.name,
      kind: options.kind,
      rows,
      added: rows.filter((r) => r.status === 'new').length,
      updated: rows.filter((r) => r.status === 'update').length,
      skipped: rows.filter((r) => ['duplicate', 'skipped'].includes(r.status)).length,
      errors: rows.filter((r) => r.status === 'error').length,
      revision: this.repo.revision()
    }
    this.prepared = { preview, operations, expires: Date.now() + 10 * 60_000 }
    return preview
  }
  async commit(token: string): Promise<ImportBatch> {
    const prepared = this.prepared
    if (!prepared || prepared.preview.token !== token || prepared.expires < Date.now())
      throw new Error('导入预览已过期，请重新检查。')
    if (prepared.preview.errors) throw new Error('请修正或排除全部错误行后再导入。')
    if (!prepared.operations.length) throw new Error('没有需要导入的记录。')
    if (prepared.preview.revision !== this.repo.revision())
      throw new Error('账本已发生变化，请重新预览后导入。')
    // Consume before awaiting so double-clicks cannot commit the same batch twice.
    this.prepared = null
    const safetyBackup = await this.backups.beforeImport()
    const batch: ImportBatch = {
      id: randomUUID(),
      source: prepared.preview.source,
      kind: prepared.preview.kind,
      createdAt: this.now().toISOString(),
      added: prepared.preview.added,
      updated: prepared.preview.updated,
      skipped: prepared.preview.skipped,
      safetyBackup
    }
    this.repo.commitCsv(prepared.operations, batch, prepared.preview.revision)
    this.backups.changed()
    return batch
  }
}
const fieldNames = Object.fromEntries(
  [
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
  ].map((f) => [f, true])
)
